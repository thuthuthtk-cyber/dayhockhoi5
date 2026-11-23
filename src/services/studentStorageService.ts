import { StudentRecord, StudentEnrollmentRecord } from '../types';
import { db, auth, ensureFirebaseAuthSession, ensureFirebaseAuthSessionWithStatus } from './firebase';
import { signInAnonymously } from 'firebase/auth';
import { handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, getDoc, onSnapshot, collection, query, where, getDocs } from 'firebase/firestore';
import { trackedSetDoc, trackedDeleteDoc, trackedWriteBatch, extractFirestoreErrorDetails } from './firestoreWriteTracker';
import { formatStandardStudentCode, normalizeStudentCode, normalizeStudentName, preserveRawStudentCode, parseStudentCode, getStudentCodeLookupVariants } from './studentCode';
import { propagateStudentCodeChange } from './unmatchedSubmissionsService';
import { isAdmin, getAllAccessibleClasses, canManageClass, UserPermissionsProfile } from '../utils/permissions';
import { sanitizeForFirestore, sanitizeFirestoreDocId } from '../utils/firestoreSanitizer';
import { normalizeClassKeyStrict, getClassKeyLookupVariants } from './classStorageService';
import { pickPreferredStudentRecord, syncPublicRosterToFirestore } from './studentDuplicateCleanupService';
import { clearMemoryTrackingData, clearIndexedDBTrackingData } from './assignmentTrackingData';
// import { safeStorage } from '../utils/safeStorage';

const PRIMARY_SCHOOL_SUBJECTS = [
  'Toán', 'Tiếng Việt', 'Đạo Đức', 'Tự nhiên và Xã hội', 'Khoa học',
  'Lịch sử và Địa lý', 'Ngoại ngữ (Tiếng Anh)', 'Tin học', 'Công nghệ',
  'Âm nhạc', 'Mĩ thuật', 'Giáo dục thể chất', 'Hoạt động trải nghiệm'
];

export const EDUPLAY_STUDENTS_DB_KEY = 'eduplay_k5_students_database';
export const EDUPLAY_CLASSES_DATA_KEY = 'eduplay_k5_classes_data';

/**
 * Hàm chuẩn hóa khóa lớp dùng chung (bỏ "Lớp"/"lop", bỏ khoảng trắng, viết hoa: " lớp 5d " -> "5D")
 */
export function normalizeClassKey(className?: string): string {
  return normalizeClassKeyStrict(className);
}

/**
 * Convert normalized key back to standard display format (e.g. "5c", "LỚP 5C", "Lớp LỚP 5C" -> "Lớp 5C")
 */
export function getStandardClassName(classKeyOrName?: string): string {
  const key = normalizeClassKey(classKeyOrName);
  return key ? `Lớp ${key}` : '';
}

/**
 * Extract numerical sequence or index from student ID/Code/STT (e.g. "st-5c-37" -> 37, "5d12" -> 12, stt -> 12)
 */
export function extractStudentNumericIndex(student: StudentRecord): number {
  if (!student) return 0;
  if (typeof student.stt === 'number' && !isNaN(student.stt) && student.stt > 0) {
    return student.stt;
  }
  // Try extracting number from id e.g. "st-5c-37" or "st-5d-5"
  const idMatch = (student.id || '').match(/(\d+)(?!.*\d)/);
  if (idMatch && idMatch[1]) {
    const num = parseInt(idMatch[1], 10);
    if (!isNaN(num)) return num;
  }
  // Try extracting from code e.g. "5c37"
  const codeMatch = (student.code || '').match(/(\d+)(?!.*\d)/);
  if (codeMatch && codeMatch[1]) {
    const num = parseInt(codeMatch[1], 10);
    if (!isNaN(num)) return num;
  }
  return 0;
}

/**
 * Deduplicate student records and guarantee clean, strictly unique IDs without dropping non-5C classes
 * or re-numbering existing STT / mutating existing stored studentCode.
 */
export function deduplicateAndNormalizeStudents(
  students: StudentRecord[],
  className?: string
): StudentRecord[] {
  if (!Array.isArray(students)) return [];

  const targetKey = className ? normalizeClassKey(className) : '';
  const stdName = targetKey ? `Lớp ${targetKey}` : '';
  const codeSlotMap = new Map<string, number>();
  const nameSlotMap = new Map<string, number>();
  const uniqueStudents: StudentRecord[] = [];

  students.forEach((st) => {
    if (!st || typeof st !== 'object') return;
    const rawName = (st.name || st.fullName || '').trim();
    if (!rawName) return;

    const rawStoredCode = preserveRawStudentCode(st.studentCode || st.code || '');
    const canonicalCode = normalizeStudentCode(rawStoredCode);
    const effectiveKey = targetKey || normalizeClassKey(st.className || (st as any).classKey || (st as any).classId);

    // Filter out stray students ONLY when targetKey is explicitly known and code explicitly belongs to another class
    if (canonicalCode && effectiveKey) {
      const classPrefixMatch = canonicalCode.match(/^([A-Z0-9]+)\d{2}-\d{2}-\d+$/);
      if (classPrefixMatch && classPrefixMatch[1] && classPrefixMatch[1] !== effectiveKey) {
        return;
      }
    }

    const normName = normalizeStudentName(st.fullName || st.name);
    const codeKey = canonicalCode;
    const nameKey = normName || '';

    const existingIdxByCode = codeKey ? codeSlotMap.get(codeKey) : undefined;
    const existingIdxByName = nameKey ? nameSlotMap.get(nameKey) : undefined;
    const matchedIdx = existingIdxByCode !== undefined ? existingIdxByCode : existingIdxByName;

    if (matchedIdx !== undefined) {
      const currentWinner = uniqueStudents[matchedIdx];
      const nextWinner = pickPreferredStudentRecord(currentWinner, st);
      if (nextWinner !== currentWinner) {
        uniqueStudents[matchedIdx] = nextWinner;
        const winCode = normalizeStudentCode(preserveRawStudentCode(nextWinner.studentCode || nextWinner.code || ''));
        const winName = normalizeStudentName(nextWinner.fullName || nextWinner.name);
        if (winCode) codeSlotMap.set(winCode, matchedIdx);
        if (winName) nameSlotMap.set(winName, matchedIdx);
      }
      return;
    }

    const newIdx = uniqueStudents.length;
    uniqueStudents.push(st);
    if (codeKey) codeSlotMap.set(codeKey, newIdx);
    if (nameKey) nameSlotMap.set(nameKey, newIdx);
  });

  // Track used STTs so we never renumber existing STTs; only assign next unused STT if missing
  const usedStts = new Set<number>();
  uniqueStudents.forEach((st) => {
    const parsed = parseStudentCode(st.studentCode || st.code);
    const existingStt = typeof st.stt === 'number' && st.stt > 0 ? st.stt : (parsed?.stt || 0);
    if (existingStt > 0) usedStts.add(existingStt);
  });
  let maxExistingStt = usedStts.size > 0 ? Math.max(...Array.from(usedStts)) : 0;

  const finalSeenIds = new Set<string>();
  return uniqueStudents.map((st, idx) => {
    const rowKey = targetKey || normalizeClassKey(st.className || (st as any).classKey || (st as any).classId) || '5C';
    const rowStdName = stdName || getStandardClassName(st.className || rowKey) || `Lớp ${rowKey}`;

    const rawStoredCode = preserveRawStudentCode(st.studentCode || st.code || '');
    const parsedFromCode = parseStudentCode(rawStoredCode);
    let assignedStt =
      typeof st.stt === 'number' && !isNaN(st.stt) && st.stt > 0
        ? st.stt
        : (parsedFromCode?.stt || 0);

    if (!assignedStt) {
      maxExistingStt += 1;
      assignedStt = maxExistingStt;
    }

    // Preserve existing stored code unchanged when it already belongs to this class or is valid standard format
    let code = rawStoredCode;
    if (!code) {
      code = `${rowKey}26-27-${assignedStt}`;
    } else if (!/^[A-Z0-9]+\d{2}-\d{2}-\d+$/.test(code)) {
      code = formatStandardStudentCode(code, rowKey, assignedStt);
    }

    // Ensure every record has a unique ID and no collisions
    let id = st.id && !finalSeenIds.has(st.id) ? st.id : `st-${rowKey.toLowerCase()}-${assignedStt}`;
    if (finalSeenIds.has(id)) {
      id = `st-${rowKey.toLowerCase()}-${assignedStt}-${idx + 1}`;
    }
    finalSeenIds.add(id);

    const sddcn = (st.sddcn && st.sddcn.trim().length > 0)
      ? st.sddcn.trim()
      : (st.idCard && st.idCard.trim().length > 0)
      ? st.idCard.trim()
      : '';

    const rawName = (st.name || st.fullName || '').trim();
    const rawFullName = (st.fullName || st.name || '').trim();

    return {
      ...st,
      id,
      name: rawName,
      fullName: rawFullName,
      stt: assignedStt,
      code,
      studentCode: code,
      sddcn,
      studentPersistentId: sddcn,
      academicYear: st.academicYear || '2026-2027',
      username: st.username ? preserveRawStudentCode(st.username) : code,
      className: rowStdName,
      pin: st.pin || st.password || '123456',
      password: st.password || st.pin || '123456'
    };
  });
}

/**
 * Extract Vietnamese name sorting key (Tên main given name first, then Họ & tên đệm)
 * E.g., "Hà Phương Vy" -> "Vy Hà Phương", "Nguyễn Văn An" -> "An Nguyễn Văn", "Bùi Hà Kim Nhung" -> "Nhung Bùi Hà Kim"
 */
export function getVietnameseNameSortKey(fullName: string): string {
  if (!fullName) return '';
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length <= 1) return trimmed;
  const firstName = parts[parts.length - 1]; // Tên chính
  const middleAndLast = parts.slice(0, parts.length - 1).join(' '); // Họ & tên đệm
  return `${firstName} ${middleAndLast}`;
}

/**
 * Sort students array in ALPHABETICAL order A-Z by Vietnamese Name
 */
export function sortStudentsByNameAZ(students: StudentRecord[], className?: string): StudentRecord[] {
  if (!Array.isArray(students)) return [];
  const deduped = deduplicateAndNormalizeStudents(students, className);
  return deduped.sort((a, b) => {
    const nameA = (a.fullName || a.name || '').trim();
    const nameB = (b.fullName || b.name || '').trim();

    const keyA = getVietnameseNameSortKey(nameA);
    const keyB = getVietnameseNameSortKey(nameB);
    const cmpName = keyA.localeCompare(keyB, 'vi', { sensitivity: 'base' });
    if (cmpName !== 0) return cmpName;

    const cmpFull = nameA.localeCompare(nameB, 'vi', { sensitivity: 'base' });
    if (cmpFull !== 0) return cmpFull;

    return (a.id || '').localeCompare(b.id || '', undefined, { numeric: true });
  });
}

/**
 * Sort students array in REVERSE ALPHABETICAL order Z-A by Vietnamese Name
 */
export function sortStudentsByNameZA(students: StudentRecord[], className?: string): StudentRecord[] {
  if (!Array.isArray(students)) return [];
  const deduped = deduplicateAndNormalizeStudents(students, className);
  return deduped.sort((a, b) => {
    const nameA = (a.fullName || a.name || '').trim();
    const nameB = (b.fullName || b.name || '').trim();

    const keyA = getVietnameseNameSortKey(nameA);
    const keyB = getVietnameseNameSortKey(nameB);
    const cmpName = keyB.localeCompare(keyA, 'vi', { sensitivity: 'base' });
    if (cmpName !== 0) return cmpName;

    const cmpFull = nameB.localeCompare(nameA, 'vi', { sensitivity: 'base' });
    if (cmpFull !== 0) return cmpFull;

    return (b.id || '').localeCompare(a.id || '', undefined, { numeric: true });
  });
}

/**
 * Sort students array in DESCENDING order by Student ID / STT (e.g. 37, 36, ... 12, 11, ... 1)
 */
export function sortStudentsDescending(students: StudentRecord[], className?: string): StudentRecord[] {
  if (!Array.isArray(students)) return [];
  const deduped = deduplicateAndNormalizeStudents(students, className);
  return deduped.sort((a, b) => {
    const numA = extractStudentNumericIndex(a);
    const numB = extractStudentNumericIndex(b);
    if (numA !== numB) {
      return numB - numA;
    }
    return (b.id || '').localeCompare(a.id || '', undefined, { numeric: true, sensitivity: 'base' });
  });
}

/**
 * Sort students array in ASCENDING order by Student ID / STT (e.g. 1, 2, ... 37)
 */
export function sortStudentsAscending(students: StudentRecord[], className?: string): StudentRecord[] {
  if (!Array.isArray(students)) return [];
  const deduped = deduplicateAndNormalizeStudents(students, className);
  return deduped.sort((a, b) => {
    const numA = extractStudentNumericIndex(a);
    const numB = extractStudentNumericIndex(b);
    if (numA !== numB) {
      return numA - numB;
    }
    return (a.id || '').localeCompare(b.id || '', undefined, { numeric: true, sensitivity: 'base' });
  });
}

const STANDARD_3C_NAMES = [
  'Nguyễn Văn An', 'Trần Đức Bảo', 'Lê Minh Cường', 'Phạm Quốc Dũng', 'Hoàng Văn Đức',
  'Vũ Gia Huy', 'Bùi Hoàng Nam', 'Đỗ Minh Triết', 'Ngô Thành Vinh', 'Trịnh Đức Anh',
  'Đặng Bảo Nam', 'Võ Văn Kiệt', 'Nguyễn Nhật Minh', 'Phạm Hải Đăng', 'Dương Quốc Trung',
  'Nguyễn Khánh Nam', 'Đào Minh Quân', 'Hồ Văn Hùng', 'Nguyễn Gia Bảo', 'Trịnh Hoàng Long',
  'Lê Thị Mai', 'Trần Phương Thảo', 'Phạm Ngọc Anh', 'Nguyễn Khánh Linh', 'Hoàng Thùy Linh',
  'Bùi Bảo Ngọc', 'Đỗ Quỳnh Anh', 'Ngô Thanh Hà', 'Vũ Phương Anh', 'Trịnh Thu Hà',
  'Nguyễn Hoài An', 'Đặng Linh Chi', 'Võ Minh Châu', 'Nguyễn Ngọc Mai', 'Phạm Yến Nhi',
  'Hoàng Mỹ Duyên', 'Đào Thị Hồng', 'Trịnh Bảo Trang'
];

/**
 * Generate default roster for class 5C
 */
export function getDefault5CRoster(): StudentRecord[] {
  return generateDefaultClassRoster('Lớp 5C', 35);
}

/**
 * Generate default roster for class 5D
 */
export function getDefault5DRoster(): StudentRecord[] {
  return generateDefaultClassRoster('Lớp 5D', 35);
}

/**
 * Danh sách học sinh lớp 3C chuẩn hóa 38 học sinh theo định dạng Mã HS 3C26-27-1 đến 3C26-27-38
 */
export function getDefault3CRoster(): StudentRecord[] {
  const cleanClass = '3C';
  return STANDARD_3C_NAMES.map((name, idx) => {
    const stt = idx + 1;
    const isMale = idx < 20;
    return {
      id: `st-3c-${stt}`,
      stt,
      code: `${cleanClass}26-27-${stt}`,
      name,
      fullName: name,
      gender: isMale ? ('Nam' as const) : ('Nữ' as const),
      dob: `${String((stt % 28) + 1).padStart(2, '0')}/05/2016`,
      className: 'Lớp 3C',
      parentName: `${isMale ? 'Nguyễn' : 'Trần'} Văn ${name.split(' ').slice(-1)[0]}`,
      phone: `0985${String(100000 + stt * 1357).slice(-6)}`,
      email: `hs.3c${stt}@quanghungpk1.edu.vn`,
      status: 'active' as const,
      conduct: 'Tốt' as const,
      avgScore: 8.5,
      avatar: '🌟',
      sddcn: `03831600${String(1000 + stt).slice(-4)}`
    };
  });
}

/**
 * Return roster for any class with standard Student Codes [CLASS]26-27-[STT]
 */
export function generateDefaultClassRoster(className: string, count: number = 38): StudentRecord[] {
  const stdName = getStandardClassName(className);
  const cleanClass = normalizeClassKey(stdName);
  const actualCount = count > 0 ? count : 38;
  return Array.from({ length: actualCount }).map((_, idx) => {
    const stt = idx + 1;
    const isMale = idx % 2 === 0;
    const name = STANDARD_3C_NAMES[idx % STANDARD_3C_NAMES.length];
    return {
      id: `st-${cleanClass.toLowerCase()}-${stt}`,
      stt,
      code: `${cleanClass}26-27-${stt}`,
      name,
      fullName: name,
      gender: isMale ? ('Nam' as const) : ('Nữ' as const),
      dob: `${String((stt % 28) + 1).padStart(2, '0')}/05/2016`,
      className: stdName,
      parentName: `${isMale ? 'Nguyễn' : 'Trần'} Văn ${name.split(' ').slice(-1)[0]}`,
      phone: `0985${String(100000 + stt * 1357).slice(-6)}`,
      email: `hs.${cleanClass.toLowerCase()}${stt}@quanghungpk1.edu.vn`,
      status: 'active' as const,
      conduct: 'Tốt' as const,
      avgScore: 8.0,
      avatar: '🌟',
      sddcn: `03831600${String(1000 + stt).slice(-4)}`
    };
  });
}

/**
 * Tính toán sĩ số thực tế chuẩn xác của lớp dựa trên danh sách học sinh thực tế
 */
export function getClassStudentCount(className: string, fallbackCount?: number): number {
  if (!className) return fallbackCount || 0;
  const roster = getStudentsFromLocalStorage(className);
  if (roster && Array.isArray(roster) && roster.length > 0) {
    return roster.length;
  }
  return fallbackCount || 38;
}

/**
 * Initial full database of all classes
 */
export function getInitialStudentDatabase(): Record<string, StudentRecord[]> {
  return {};
}

/**
 * Get students for a specific class from LocalStorage with fallback
 */
export function getStudentsFromLocalStorage(className: string): StudentRecord[] | null {
  if (typeof window === 'undefined') return null;

  try {
    const key = normalizeClassKey(className);
    if (!key) return null;
    const stdName = `Lớp ${key}`;

    // If explicitly cleared, return []
    if (localStorage.getItem(`eduplay_k5_cleared_${key}`) === 'true' || localStorage.getItem(`eduplay_k5_cleared_${key.toLowerCase()}`) === 'true') {
      return [];
    }

    // 1. Check direct per-class key and variant keys (read-only)
    const candidateKeys = [
      `eduplay_k5_students_${key}`,
      `eduplay_k5_students_${key.toLowerCase()}`,
      `eduplay_k5_students_${stdName}`,
      `eduplay_k5_students_${stdName.toLowerCase()}`
    ];
    for (const lsKey of candidateKeys) {
      const directData = localStorage.getItem(lsKey);
      if (directData !== null) {
        try {
          const parsed = JSON.parse(directData);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return deduplicateAndNormalizeStudents(parsed, stdName);
          }
        } catch {}
      }
    }

    // 2. Check full database key (eduplay_k5_students_database)
    const fullDbData = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
    if (fullDbData) {
      try {
        const parsedDb = JSON.parse(fullDbData);
        if (parsedDb && typeof parsedDb === 'object') {
          if (Array.isArray(parsedDb[stdName]) && parsedDb[stdName].length > 0) {
            return deduplicateAndNormalizeStudents(parsedDb[stdName], stdName);
          }
          if (Array.isArray(parsedDb[key]) && parsedDb[key].length > 0) {
            return deduplicateAndNormalizeStudents(parsedDb[key], stdName);
          }
          if (Array.isArray(parsedDb[key.toLowerCase()]) && parsedDb[key.toLowerCase()].length > 0) {
            return deduplicateAndNormalizeStudents(parsedDb[key.toLowerCase()], stdName);
          }
          for (const [rawK, listVal] of Object.entries(parsedDb)) {
            if (normalizeClassKey(rawK) === key && Array.isArray(listVal) && listVal.length > 0) {
              return deduplicateAndNormalizeStudents(listVal as StudentRecord[], stdName);
            }
          }
        }
      } catch {}
    }

    // Read-only fallback check if direct key held an explicit empty array
    for (const lsKey of candidateKeys) {
      const directData = localStorage.getItem(lsKey);
      if (directData !== null) {
        try {
          const parsed = JSON.parse(directData);
          if (Array.isArray(parsed)) {
            return [];
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('Lỗi đọc LocalStorage học sinh:', err);
  }

  return null;
}

/**
 * Get all students for all classes from LocalStorage with dual key resolution
 */
export function getAllStudentsFromLocalStorage(): Record<string, StudentRecord[]> {
  if (typeof window === 'undefined') return getInitialStudentDatabase();

  const cleanedDb: Record<string, StudentRecord[]> = {};

  try {
    // 1. Read master database object
    const fullDbData = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
    if (fullDbData) {
      const parsedDb = JSON.parse(fullDbData);
      if (parsedDb && typeof parsedDb === 'object') {
        Object.entries(parsedDb).forEach(([cls, list]) => {
          if (Array.isArray(list) && list.length > 0) {
            const stdName = getStandardClassName(cls);
            const key = normalizeClassKey(cls);
            const deduped = deduplicateAndNormalizeStudents(list as StudentRecord[], stdName);
            cleanedDb[stdName] = deduped;
            cleanedDb[key] = deduped;
          }
        });
      }
    }

    // 2. Scan all individual per-class storage keys (e.g. eduplay_k5_students_5D, eduplay_k5_students_5C, etc.)
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (storageKey && storageKey.startsWith('eduplay_k5_students_') && storageKey !== EDUPLAY_STUDENTS_DB_KEY) {
        const classKey = storageKey.replace('eduplay_k5_students_', '').trim();
        const stdName = getStandardClassName(classKey);
        const normKey = normalizeClassKey(classKey);
        if (!cleanedDb[stdName] || cleanedDb[stdName].length === 0) {
          const itemData = localStorage.getItem(storageKey);
          if (itemData) {
            try {
              const parsed = JSON.parse(itemData);
              if (Array.isArray(parsed) && parsed.length > 0) {
                const deduped = deduplicateAndNormalizeStudents(parsed, stdName);
                cleanedDb[stdName] = deduped;
                cleanedDb[normKey] = deduped;
              }
            } catch {}
          }
        }
      }
    }
  } catch (err) {
    console.warn('Lỗi đọc toàn bộ LocalStorage học sinh:', err);
  }

  return cleanedDb;
}

/**
 * Save all students database to LocalStorage & per-class keys (guaranteeing both standard and short key entries)
 */
export function saveAllStudentsToLocalStorage(dbData: Record<string, StudentRecord[]>) {
  if (typeof window === 'undefined') return;

  try {
    const cleanedDb: Record<string, StudentRecord[]> = {};
    Object.entries(dbData).forEach(([clsName, students]) => {
      if (!Array.isArray(students) || students.length === 0) return;
      const stdName = getStandardClassName(clsName);
      const key = normalizeClassKey(clsName);
      const cleaned = deduplicateAndNormalizeStudents(students, stdName);
      cleanedDb[stdName] = cleaned;
      cleanedDb[key] = cleaned;
      localStorage.setItem(`eduplay_k5_students_${key}`, JSON.stringify(cleaned));
      if (key !== key.toLowerCase()) {
        localStorage.setItem(`eduplay_k5_students_${key.toLowerCase()}`, JSON.stringify(cleaned));
      }
    });

    localStorage.setItem(EDUPLAY_STUDENTS_DB_KEY, JSON.stringify(cleanedDb));

    // Dispatch real-time events for instant UI synchronization asynchronously
    setTimeout(() => {
      try {
        window.dispatchEvent(
          new CustomEvent('student-data-updated', {
            detail: { action: 'all-updated', dbData: cleanedDb, timestamp: Date.now() }
          })
        );
        window.dispatchEvent(
          new CustomEvent('eduplay_k5_students_updated', {
            detail: { action: 'all-updated' }
          })
        );
      } catch {}
    }, 0);
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (!msg.includes('INTERNAL ASSERTION FAILED') && !msg.includes('b815') && !msg.includes('ca9')) {
      console.error('Lỗi lưu toàn bộ học sinh vào LocalStorage:', err);
    }
  }
}

/**
 * Save students for a specific class to LocalStorage & dispatch window events
 */
export function saveStudentsToLocalStorage(className: string, students: StudentRecord[]) {
  if (typeof window === 'undefined') return;

  try {
    const stdName = getStandardClassName(className);
    const key = normalizeClassKey(className);

    // Clear any explicit cleared marker when saving new students
    localStorage.removeItem(`eduplay_k5_cleared_${key}`);
    localStorage.removeItem(`eduplay_k5_cleared_${key.toLowerCase()}`);

    const cleaned = deduplicateAndNormalizeStudents(students, stdName);

    // Remove stale localStorage variant keys for this class (e.g. lowercase or "Lớp 5D")
    const staleKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const lsKey = localStorage.key(i);
      if (lsKey && lsKey.startsWith('eduplay_k5_students_') && lsKey !== EDUPLAY_STUDENTS_DB_KEY) {
        const suffix = lsKey.replace('eduplay_k5_students_', '');
        if (normalizeClassKey(suffix) === key && lsKey !== `eduplay_k5_students_${key}`) {
          staleKeys.push(lsKey);
        }
      }
    }
    staleKeys.forEach((k) => localStorage.removeItem(k));

    // 1. Save to canonical direct per-class key (e.g. eduplay_k5_students_5D)
    localStorage.setItem(`eduplay_k5_students_${key}`, JSON.stringify(cleaned));

    // 2. Update the full database object (remove variant keys for this class)
    let fullDb: Record<string, StudentRecord[]> = {};
    const fullDbData = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
    if (fullDbData) {
      try {
        fullDb = JSON.parse(fullDbData) || {};
      } catch {
        fullDb = {};
      }
    }
    Object.keys(fullDb).forEach((rawK) => {
      if (normalizeClassKey(rawK) === key && rawK !== stdName && rawK !== key) {
        delete fullDb[rawK];
      }
    });
    fullDb[stdName] = cleaned;
    fullDb[key] = cleaned;
    localStorage.setItem(EDUPLAY_STUDENTS_DB_KEY, JSON.stringify(fullDb));

    // 3. Dispatch real-time events for instant UI reactivity across components asynchronously
    setTimeout(() => {
      try {
        window.dispatchEvent(
          new CustomEvent('student-data-updated', {
            detail: {
              className: stdName,
              classKey: key,
              count: cleaned.length,
              students: cleaned,
              action: 'saved',
              timestamp: Date.now()
            }
          })
        );
        window.dispatchEvent(
          new CustomEvent('eduplay_k5_students_updated', {
            detail: { className: stdName, classKey: key, count: cleaned.length }
          })
        );
      } catch {}
    }, 0);
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (!msg.includes('INTERNAL ASSERTION FAILED') && !msg.includes('b815') && !msg.includes('ca9')) {
      console.error('Lỗi lưu học sinh vào LocalStorage:', err);
    }
  }
}

/**
 * Add or update a single student in a class, updating cache and publishing events
 */
export function addOrUpdateStudentInClass(className: string, student: StudentRecord): StudentRecord[] {
  const stdName = getStandardClassName(className);
  const currentList = getStudentsFromLocalStorage(stdName) || [];
  const existingIdx = currentList.findIndex(s => s.id === student.id || (s.code && s.code === student.code));

  let updatedList: StudentRecord[];
  if (existingIdx >= 0) {
    const existingStudent = currentList[existingIdx];
    const oldCode = existingStudent.code;
    const newCode = student.code;
    if (oldCode && newCode && normalizeStudentCode(oldCode) !== normalizeStudentCode(newCode)) {
      propagateStudentCodeChange(oldCode, newCode, stdName).catch(() => {});
    }
    updatedList = [...currentList];
    updatedList[existingIdx] = { ...updatedList[existingIdx], ...student, className: stdName };
  } else {
    updatedList = [...currentList, { ...student, className: stdName }];
  }

  saveStudentsToLocalStorage(stdName, updatedList);
  syncClassStudentsToFirestore(stdName, updatedList).catch(() => {});

  window.dispatchEvent(
    new CustomEvent('student-data-updated', {
      detail: {
        className: stdName,
        action: existingIdx >= 0 ? 'student-updated' : 'student-added',
        student,
        timestamp: Date.now()
      }
    })
  );

  return updatedList;
}

/**
 * Delete a single student from a class, updating cache and publishing events
 */
export function deleteStudentFromClass(className: string, studentId: string): StudentRecord[] {
  const stdName = getStandardClassName(className);
  const currentList = getStudentsFromLocalStorage(stdName) || [];
  const target = currentList.find(s => s.id === studentId || s.code === studentId);
  const updatedList = currentList.filter(s => s.id !== studentId && s.code !== studentId);

  saveStudentsToLocalStorage(stdName, updatedList);
  syncClassStudentsToFirestore(stdName, updatedList).catch(() => {});
  if (target) {
    deleteStudentPermanently(stdName, target).catch(() => {});
  }

  window.dispatchEvent(
    new CustomEvent('student-data-updated', {
      detail: {
        className: stdName,
        action: 'student-deleted',
        deletedStudentId: studentId,
        count: updatedList.length,
        timestamp: Date.now()
      }
    })
  );

  return updatedList;
}

/**
 * Clear all students in a class
 */
export function clearAllStudentsInClass(className: string): { success: boolean; error?: string; remainingStudents: StudentRecord[] } {
  try {
    const stdName = getStandardClassName(className);
    const classKey = normalizeClassKey(className);

    localStorage.setItem(`eduplay_k5_cleared_${classKey}`, 'true');
    localStorage.setItem(`eduplay_k5_cleared_${classKey.toLowerCase()}`, 'true');
    saveStudentsToLocalStorage(stdName, []);
    localStorage.setItem(`eduplay_k5_students_${classKey}`, JSON.stringify([]));
    localStorage.removeItem(`eduplay_k5_students_${classKey.toLowerCase()}`);

    let fullDb: Record<string, StudentRecord[]> = {};
    const fullDbData = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
    if (fullDbData) {
      try {
        fullDb = JSON.parse(fullDbData) || {};
      } catch {}
    }
    Object.keys(fullDb).forEach((rawK) => {
      if (normalizeClassKey(rawK) === classKey && rawK !== stdName && rawK !== classKey) {
        delete fullDb[rawK];
      }
    });
    fullDb[stdName] = [];
    fullDb[classKey] = [];
    localStorage.setItem(EDUPLAY_STUDENTS_DB_KEY, JSON.stringify(fullDb));

    clearMemoryTrackingData();
    clearIndexedDBTrackingData().catch(() => {});
    syncClassStudentsToFirestore(stdName, []).catch(() => {});

    window.dispatchEvent(
      new CustomEvent('student-data-updated', {
        detail: {
          className: stdName,
          classKey,
          action: 'all-cleared',
          count: 0,
          students: [],
          timestamp: Date.now()
        }
      })
    );
    window.dispatchEvent(
      new CustomEvent('eduplay_k5_students_updated', {
        detail: { className: stdName, classKey, count: 0, action: 'all-cleared' }
      })
    );

    return { success: true, remainingStudents: [] };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err), remainingStudents: [] };
  }
}

/**
 * Completely delete a student from a class across:
 * 1. Class roster in local cache & LocalStorage
 * 2. Firestore 'class_rosters' collection (both normalized uppercase and lowercase documents)
 * 3. Firestore 'students' collection (individual documents by ID/Code/query)
 * 4. Real-time window sync events
 */
export async function deleteStudentPermanently(
  className: string,
  student: StudentRecord
): Promise<{ success: boolean; error?: string; remainingStudents: StudentRecord[] }> {
  try {
    const stdName = getStandardClassName(className);
    const classKey = normalizeClassKey(className);

    // 1. Gather current list from LocalStorage AND Firestore so no stale cloud entries are left behind
    const localCurrent = getStudentsFromLocalStorage(stdName) || [];
    const cloudCurrent = (await fetchClassStudentsFromFirestore(stdName)) || [];
    const combinedMap = new Map<string, StudentRecord>();
    [...localCurrent, ...cloudCurrent].forEach((s) => {
      const k = normalizeStudentCode(s.studentCode || s.code) || s.id || normalizeStudentName(s.fullName || s.name);
      if (k) {
        const existing = combinedMap.get(k);
        combinedMap.set(k, existing ? pickPreferredStudentRecord(existing, s) : s);
      }
    });
    const currentList = Array.from(combinedMap.values());

    const targetCodeNorm = normalizeStudentCode(student.studentCode || student.code);
    const targetNameNorm = normalizeStudentName(student.fullName || student.name);

    // Filter out matching student by ID, normalized Code, SDDCN, or normalized Name+DOB (or exact code match)
    const filtered = currentList.filter((s) => {
      if (student.id && s.id && s.id === student.id) return false;
      const sCodeNorm = normalizeStudentCode(s.studentCode || s.code);
      if (targetCodeNorm && sCodeNorm && targetCodeNorm === sCodeNorm) return false;
      if (student.sddcn && s.sddcn && s.sddcn === student.sddcn) return false;
      const sNameNorm = normalizeStudentName(s.fullName || s.name);
      if (targetNameNorm && sNameNorm && targetNameNorm === sNameNorm) {
        if (!student.dob || !s.dob || s.dob === student.dob) return false;
      }
      return true;
    });

    const updated = deduplicateAndNormalizeStudents(filtered, stdName);

    // 2. Save updated list to LocalStorage immediately & clear variant keys
    saveStudentsToLocalStorage(stdName, updated);

    // 3. Sync ALL 3 Firestore collections (`class_rosters`, `public_rosters`, `students`) + `classes` + IndexedDB
    if (db) {
      await ensureFirebaseAuthSession();
      const nowIso = new Date().toISOString();
      const maleCount = updated.filter((s) => s.gender === 'Nam').length;
      const femaleCount = updated.filter((s) => s.gender === 'Nữ').length;
      const safeClassKey = sanitizeFirestoreDocId(classKey, classKey);
      const cleanUpdated = updated.map((s) =>
        sanitizeForFirestore({
          ...s,
          classKey,
          className: stdName,
          grade: 'Khối 5',
          updatedAt: nowIso
        })
      );

      // 3a. Overwrite canonical 'class_rosters/{KEY}' (without merge so removed elements never persist)
      const rosterRefUpper = doc(db, 'class_rosters', safeClassKey);
      await trackedSetDoc(
        rosterRefUpper,
        sanitizeForFirestore({
          className: stdName,
          classKey,
          grade: 'Khối 5',
          totalStudents: cleanUpdated.length,
          male: maleCount,
          female: femaleCount,
          students: cleanUpdated,
          updatedAt: nowIso
        }),
        undefined,
        { isUserInitiated: true, actionType: 'admin_batch' }
      );

      // Remove or clean any variant class_rosters docs (lowercase `5d`, `Lớp 5D`, etc.)
      const rosterVariantIds = getClassKeyLookupVariants(classKey).filter((v) => v !== safeClassKey);
      for (const vid of rosterVariantIds) {
        const safeVid = sanitizeFirestoreDocId(vid, '');
        if (!safeVid || safeVid === safeClassKey) continue;
        try {
          const vSnap = await getDoc(doc(db, 'class_rosters', safeVid));
          if (vSnap.exists()) {
            try {
              await trackedDeleteDoc(doc(db, 'class_rosters', safeVid), { isUserInitiated: true, actionType: 'admin_batch' });
            } catch {
              await trackedSetDoc(
                doc(db, 'class_rosters', safeVid),
                sanitizeForFirestore({
                  className: stdName,
                  classKey: safeVid,
                  totalStudents: 0,
                  male: 0,
                  female: 0,
                  students: [],
                  updatedAt: nowIso
                }),
                undefined,
                { isUserInitiated: true, actionType: 'admin_batch' }
              );
            }
          }
        } catch {}
      }

      // 3b. Synchronize 'public_rosters/{KEY}' (and remove variants)
      await syncPublicRosterToFirestore(stdName, cleanUpdated as StudentRecord[]).catch(() => {});

      // 3c. Delete ALL matching docs in 'students' collection (ID, code variants, studentCode field, and class scan)
      const studentDocIdsToDelete = new Set<string>();
      if (student.id) studentDocIdsToDelete.add(student.id);
      getStudentCodeLookupVariants(student.studentCode || student.code).forEach((v) => studentDocIdsToDelete.add(v));

      try {
        const codeVariants = getStudentCodeLookupVariants(student.studentCode || student.code).slice(0, 10);
        if (codeVariants.length > 0) {
          const [qCodeSnap, qStudentCodeSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('code', 'in', codeVariants))),
            getDocs(query(collection(db, 'students'), where('studentCode', 'in', codeVariants)))
          ]);
          qCodeSnap.forEach((d) => studentDocIdsToDelete.add(d.id));
          qStudentCodeSnap.forEach((d) => studentDocIdsToDelete.add(d.id));
        }
        // Scan class docs in 'students' to catch mismatched docIds or same-name stale docs
        const classVariants = getClassKeyLookupVariants(classKey).slice(0, 10);
        const [qClsKeySnap, qClsNameSnap] = await Promise.all([
          getDocs(query(collection(db, 'students'), where('classKey', '==', classKey))),
          classVariants.length > 0
            ? getDocs(query(collection(db, 'students'), where('className', 'in', classVariants)))
            : Promise.resolve(null as any)
        ]);
        const checkClassSnap = (snap: any) => {
          if (!snap) return;
          snap.forEach((d: any) => {
            const data = d.data() as any;
            const dCodeNorm = normalizeStudentCode(data?.studentCode || data?.code || d.id);
            const dNameNorm = normalizeStudentName(data?.fullName || data?.name);
            if (
              (student.id && d.id === student.id) ||
              (targetCodeNorm && dCodeNorm === targetCodeNorm) ||
              (student.sddcn && data?.sddcn === student.sddcn) ||
              (targetNameNorm && dNameNorm === targetNameNorm && (!student.dob || !data?.dob || data.dob === student.dob))
            ) {
              studentDocIdsToDelete.add(d.id);
            }
          });
        };
        checkClassSnap(qClsKeySnap);
        checkClassSnap(qClsNameSnap);
      } catch (err) {
        console.warn('Query delete student warning:', err);
      }

      const deleteIdsArr = Array.from(studentDocIdsToDelete).filter(Boolean);
      for (let i = 0; i < deleteIdsArr.length; i += 450) {
        const chunk = deleteIdsArr.slice(i, i + 450);
        const batch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
        chunk.forEach((idToDel) => batch.delete(doc(db, 'students', idToDel)));
        await batch.commit();
      }

      // 3d. Update 'classes/{KEY}' totalStudents
      try {
        await trackedSetDoc(
          doc(db, 'classes', safeClassKey),
          sanitizeForFirestore({ id: classKey, name: stdName, totalStudents: cleanUpdated.length, updatedAt: nowIso }),
          { merge: true },
          { isUserInitiated: true, actionType: 'admin_batch' }
        );
      } catch {}
    }

    // Clear IndexedDB & memory tracking cache
    clearMemoryTrackingData();
    await clearIndexedDBTrackingData().catch(() => {});

    // 4. Dispatch live sync events asynchronously
    setTimeout(() => {
      try {
        window.dispatchEvent(
          new CustomEvent('student-data-updated', {
            detail: {
              className: stdName,
              classKey,
              deletedStudent: student,
              count: updated.length,
              students: updated,
              action: 'student-deleted',
              timestamp: Date.now()
            }
          })
        );
        window.dispatchEvent(
          new CustomEvent('eduplay_k5_students_updated', {
            detail: {
              className: stdName,
              classKey,
              count: updated.length,
              action: 'student-deleted'
            }
          })
        );
      } catch {}
    }, 0);

    return { success: true, remainingStudents: updated };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (!msg.includes('INTERNAL ASSERTION FAILED') && !msg.includes('b815') && !msg.includes('ca9')) {
      console.error('Lỗi khi xóa học sinh:', err);
      handleFirestoreError(err, OperationType.WRITE, 'class_rosters');
    }
    return { success: false, error: err?.message || String(err), remainingStudents: [] };
  }
}

/**
 * Sync / Save students of a class directly to Firestore (`class_rosters`, `students`, and `classes`)
 */
export async function syncClassStudentsToFirestore(
  className: string,
  students: StudentRecord[]
): Promise<{ success: boolean; syncedStudentsCount?: number; error?: string; code?: string }> {
  try {
    if (!db) {
      return { success: false, error: 'Chưa khởi tạo Cloud Firestore.', code: 'firestore/not-initialized' };
    }

    let authStatus = await ensureFirebaseAuthSessionWithStatus();
    if (!authStatus.user && auth && !auth.currentUser) {
      try {
        const cred = await signInAnonymously(auth);
        authStatus = { user: cred.user, errorCode: null, errorMessage: null };
      } catch (anonErr: any) {
        const details = extractFirestoreErrorDetails(anonErr);
        return { success: false, error: details.message, code: details.code };
      }
    }
    if (!auth?.currentUser && authStatus.errorCode) {
      return {
        success: false,
        error: authStatus.errorMessage || 'Chưa có phiên xác thực Firebase Auth.',
        code: authStatus.errorCode
      };
    }

    const cleanInputClass = (className || '').trim();
    const classKey = normalizeClassKey(cleanInputClass);
    const stdName = getStandardClassName(classKey);
    if (!classKey || /^5[AB]\d*$/i.test(classKey)) {
      return { success: false, error: 'Lớp học không hợp lệ hoặc không thuộc Khối 5.', code: 'invalid-argument' };
    }

    const safeClassKey = sanitizeFirestoreDocId(classKey, classKey);
    const gradeDigit = stdName.replace(/[^0-9]/g, '') || '5';
    const normalizedGrade = `Khối ${gradeDigit}`;
    const nowIso = new Date().toISOString();

    const cleanedRaw = deduplicateAndNormalizeStudents(students, stdName);
    const cleaned = cleanedRaw.map((s, idx) => {
      const currentStt = s.stt && s.stt > 0 ? s.stt : (idx + 1);
      const existingCode = preserveRawStudentCode(s.studentCode || s.code);
      const standardizedCode = existingCode && /^[A-Z0-9]+\d{2}-\d{2}-\d+$/.test(existingCode)
        ? existingCode
        : preserveRawStudentCode(formatStandardStudentCode(existingCode, classKey, currentStt));

      return sanitizeForFirestore({
        ...s,
        id: s.id || `st-${classKey.toLowerCase()}-${currentStt}`,
        stt: currentStt,
        code: standardizedCode,
        studentCode: standardizedCode,
        username: preserveRawStudentCode(s.username || standardizedCode),
        className: stdName,
        classKey,
        grade: normalizedGrade,
        name: (s.name || s.fullName || '').trim(),
        fullName: (s.fullName || s.name || '').trim(),
        updatedAt: nowIso
      });
    });

    const maleCount = cleaned.filter((s) => s.gender === 'Nam').length;
    const femaleCount = cleaned.filter((s) => s.gender === 'Nữ').length;

    // 1. Overwrite full roster document in 'class_rosters/{KEY}' (without merge so old array/legacy fields never linger)
    const rosterRef = doc(db, 'class_rosters', safeClassKey);
    const rosterPayload = sanitizeForFirestore({
      className: stdName,
      classKey,
      grade: normalizedGrade,
      totalStudents: cleaned.length,
      male: maleCount,
      female: femaleCount,
      students: cleaned,
      updatedAt: nowIso
    });
    await trackedSetDoc(
      rosterRef,
      rosterPayload,
      undefined,
      { isUserInitiated: true, actionType: 'admin_batch' }
    );

    // 1b. Clean/delete non-canonical variant class_rosters docs (e.g. `5d`, `Lớp 5D`)
    const rosterVariants = getClassKeyLookupVariants(classKey).filter((v) => v !== safeClassKey);
    for (const vid of rosterVariants) {
      const safeVid = sanitizeFirestoreDocId(vid, '');
      if (!safeVid || safeVid === safeClassKey) continue;
      try {
        const vSnap = await getDoc(doc(db, 'class_rosters', safeVid));
        if (vSnap.exists()) {
          try {
            await trackedDeleteDoc(doc(db, 'class_rosters', safeVid), { isUserInitiated: true, actionType: 'admin_batch' });
          } catch {
            await trackedSetDoc(
              doc(db, 'class_rosters', safeVid),
              sanitizeForFirestore({
                className: stdName,
                classKey: safeVid,
                grade: normalizedGrade,
                totalStudents: 0,
                male: 0,
                female: 0,
                students: [],
                updatedAt: nowIso
              }),
              undefined,
              { isUserInitiated: true, actionType: 'admin_batch' }
            );
          }
        }
      } catch {}
    }

    // 2. Write every student document directly into 'students' collection AND delete stale docs of this class not in `cleaned`
    const validDocIds = new Set<string>();
    const validNormCodes = new Set<string>();
    cleaned.forEach((studentDoc) => {
      const studentDocId = sanitizeFirestoreDocId(
        studentDoc.studentCode || studentDoc.id || `${classKey}_${studentDoc.stt}`,
        `st_${classKey}_${studentDoc.stt}`
      );
      validDocIds.add(studentDocId);
      const normCode = normalizeStudentCode(studentDoc.studentCode || studentDoc.code);
      if (normCode) validNormCodes.add(normCode);
    });

    // Delete stale `students` documents belonging to this class whose normalized code & docId are NOT in `cleaned`
    try {
      const staleDocIds = new Set<string>();
      const classVariants = getClassKeyLookupVariants(classKey).slice(0, 10);
      const [qKeySnap, qNameSnap] = await Promise.all([
        getDocs(query(collection(db, 'students'), where('classKey', '==', classKey))),
        classVariants.length > 0
          ? getDocs(query(collection(db, 'students'), where('className', 'in', classVariants)))
          : Promise.resolve(null as any)
      ]);
      const collectStale = (snap: any) => {
        if (!snap) return;
        snap.forEach((d: any) => {
          const data = d.data() as any;
          const dNormCode = normalizeStudentCode(data?.studentCode || data?.code || d.id);
          const isKept = validDocIds.has(d.id) || (dNormCode && validNormCodes.has(dNormCode));
          if (!isKept) {
            staleDocIds.add(d.id);
          }
        });
      };
      collectStale(qKeySnap);
      collectStale(qNameSnap);

      const staleList = Array.from(staleDocIds);
      for (let i = 0; i < staleList.length; i += 400) {
        const chunk = staleList.slice(i, i + 400);
        const delBatch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
        chunk.forEach((id) => delBatch.delete(doc(db, 'students', id)));
        await delBatch.commit();
      }
    } catch (staleErr) {
      console.warn('Stale students cleanup warning:', staleErr);
    }

    if (cleaned.length > 0) {
      const CHUNK_SIZE = 400;
      for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
        const chunk = cleaned.slice(i, i + CHUNK_SIZE);
        const batch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
        chunk.forEach((studentDoc) => {
          const studentDocId = sanitizeFirestoreDocId(
            studentDoc.studentCode || studentDoc.id || `${classKey}_${studentDoc.stt}`,
            `st_${classKey}_${studentDoc.stt}`
          );
          const studentRef = doc(db, 'students', studentDocId);
          batch.set(studentRef, sanitizeForFirestore({
            ...studentDoc,
            docId: studentDocId,
            classKey,
            className: stdName,
            grade: normalizedGrade,
            updatedAt: nowIso
          }), { merge: true });
        });
        await batch.commit();
      }
    }

    // 3. Synchronize 'public_rosters' collection (write clean roster or 0 students)
    await syncPublicRosterToFirestore(stdName, cleaned as StudentRecord[]).catch(() => {});

    // 4. Ensure 'classes' collection document exists & matches totalStudents without overwriting homeroomTeacher/room
    const classSummaryRef = doc(db, 'classes', safeClassKey);
    await trackedSetDoc(
      classSummaryRef,
      sanitizeForFirestore({
        id: classKey,
        name: stdName,
        grade: normalizedGrade,
        totalStudents: cleaned.length,
        subjects: PRIMARY_SCHOOL_SUBJECTS.map(s => ({ isVisible: true, subjectName: s })),
        updatedAt: nowIso
      }),
      { merge: true },
      { isUserInitiated: true, actionType: 'admin_batch' }
    );

    // 5. Clear IndexedDB & memory tracking cache so stale student rosters are never served
    clearMemoryTrackingData();
    await clearIndexedDBTrackingData().catch(() => {});

    return { success: true, syncedStudentsCount: cleaned.length };
  } catch (err: any) {
    const details = extractFirestoreErrorDetails(err);
    console.warn('Lỗi đồng bộ học sinh lên Firestore:', details.message);
    return { success: false, error: details.message, code: details.code };
  }
}

/**
 * Tự động đẩy danh sách lớp & học sinh đang có trong LocalStorage lên Firestore nếu cloud chưa có
 */
export async function syncAllLocalRostersToFirestoreIfMissing(
  userProfile?: UserPermissionsProfile | null
): Promise<{ success: boolean; syncedClasses: string[]; syncedStudents: number; error?: string; code?: string }> {
  try {
    if (!db) {
      return { success: false, syncedClasses: [], syncedStudents: 0, error: 'Chưa khởi tạo Cloud Firestore.', code: 'firestore/not-initialized' };
    }

    const authStatus = await ensureFirebaseAuthSessionWithStatus();
    if (!auth?.currentUser && authStatus.errorCode) {
      return {
        success: false,
        syncedClasses: [],
        syncedStudents: 0,
        error: authStatus.errorMessage || 'Lỗi xác thực Firebase Auth.',
        code: authStatus.errorCode
      };
    }

    const localRostersRaw = getAllStudentsFromLocalStorage();
    const uniqueLocalByKey = new Map<string, { stdName: string; students: StudentRecord[] }>();
    Object.entries(localRostersRaw).forEach(([rawKey, list]) => {
      if (!Array.isArray(list) || list.length === 0) return;
      const classKey = normalizeClassKey(rawKey);
      if (!classKey || /^5[AB]\d*$/i.test(classKey)) return;
      const gradeDigit = classKey.replace(/[^0-9]/g, '');
      if (gradeDigit !== '5') return;
      if (userProfile && !isAdmin(userProfile) && !canManageClass(userProfile, classKey)) return;
      const stdName = getStandardClassName(classKey);
      const existing = uniqueLocalByKey.get(classKey);
      if (!existing || list.length > existing.students.length) {
        uniqueLocalByKey.set(classKey, { stdName, students: list });
      }
    });

    if (uniqueLocalByKey.size === 0) {
      return { success: true, syncedClasses: [], syncedStudents: 0 };
    }

    const isAdminUser = !userProfile || isAdmin(userProfile);
    const accessibleClasses = isAdminUser ? [] : getAllAccessibleClasses(userProfile);

    // Check existing non-empty class_rosters on cloud
    const rostersQuery = isAdminUser
      ? collection(db, 'class_rosters')
      : query(collection(db, 'class_rosters'), where('classKey', 'in', accessibleClasses.slice(0, 30)));
    const rostersSnap = await getDocs(rostersQuery);
    const populatedCloudRosters = new Set<string>();
    rostersSnap.forEach((d) => {
      const data = d.data() as any;
      const k = normalizeClassKey(data.classKey || data.className || d.id);
      const list = Array.isArray(data.students) ? data.students : [];
      if (k && list.length > 0) {
        populatedCloudRosters.add(k);
      }
    });

    // Check existing individual student docs in 'students' collection
    const classVariants = Array.from(new Set(accessibleClasses.flatMap((c) => [c, `Lớp ${c}`]).filter(Boolean))).slice(0, 30);
    const studentsQuery = isAdminUser
      ? collection(db, 'students')
      : query(collection(db, 'students'), where('className', 'in', classVariants));
    const studentsSnap = await getDocs(studentsQuery);
    const populatedCloudStudentClasses = new Set<string>();
    studentsSnap.forEach((d) => {
      const data = d.data() as any;
      const cls = data.classKey || data.className;
      if (cls) {
        populatedCloudStudentClasses.add(normalizeClassKey(cls));
      }
    });

    const syncedClasses: string[] = [];
    let syncedStudents = 0;

    for (const [classKey, entry] of uniqueLocalByKey.entries()) {
      const needsRosterSync = !populatedCloudRosters.has(classKey);
      const needsStudentsCollectionSync = !populatedCloudStudentClasses.has(classKey);
      if (!needsRosterSync && !needsStudentsCollectionSync) {
        continue;
      }
      const res = await syncClassStudentsToFirestore(entry.stdName, entry.students);
      if (!res.success) {
        return {
          success: false,
          syncedClasses,
          syncedStudents,
          error: res.error,
          code: res.code
        };
      }
      syncedClasses.push(entry.stdName);
      syncedStudents += res.syncedStudentsCount || entry.students.length;
    }

    return { success: true, syncedClasses, syncedStudents };
  } catch (err: any) {
    const details = extractFirestoreErrorDetails(err);
    return { success: false, syncedClasses: [], syncedStudents: 0, error: details.message, code: details.code };
  }
}

/**
 * Fetch students of a class from Firestore (STRICTLY READ-ONLY on Firestore; checks variant keys as fallback)
 */
export async function fetchClassStudentsFromFirestore(className: string): Promise<StudentRecord[] | null> {
  try {
    if (!db) return null;
    const classKey = normalizeClassKey(className);
    if (!classKey) return null;
    const stdName = `Lớp ${classKey}`;

    await ensureFirebaseAuthSession();

    const variantDocIds = Array.from(
      new Set([
        classKey,
        classKey.toLowerCase(),
        stdName,
        `LỚP ${classKey}`,
        `lớp ${classKey.toLowerCase()}`
      ])
    );

    const collected: StudentRecord[] = [];

    for (const docId of variantDocIds) {
      try {
        const docSnap = await getDoc(doc(db, 'class_rosters', docId));
        if (docSnap.exists()) {
          const data = docSnap.data() as any;
          const rawArr = Array.isArray(data?.students)
            ? data.students
            : (Array.isArray(data?.studentList) ? data.studentList : (Array.isArray(data?.roster) ? data.roster : []));
          if (Array.isArray(rawArr) && rawArr.length > 0) {
            collected.push(...(rawArr as StudentRecord[]));
            break; // Prefer canonical key first if populated
          }
        }
      } catch {}
    }

    // Read-only fallback to 'public_rosters' if class_rosters has 0 items
    if (collected.length === 0) {
      for (const docId of variantDocIds) {
        try {
          const pubSnap = await getDoc(doc(db, 'public_rosters', docId));
          if (pubSnap.exists()) {
            const data = pubSnap.data() as any;
            const rawArr = Array.isArray(data?.students)
              ? data.students
              : (Array.isArray(data?.studentList) ? data.studentList : (Array.isArray(data?.roster) ? data.roster : []));
            if (Array.isArray(rawArr) && rawArr.length > 0) {
              collected.push(...(rawArr as StudentRecord[]));
              break;
            }
          }
        } catch {}
      }
    }

    // Read-only fallback to 'students' collection if class_rosters & public_rosters have 0 items
    if (collected.length === 0) {
      try {
        const variants = getClassKeyLookupVariants(classKey).slice(0, 10);
        const qByKey = query(collection(db, 'students'), where('classKey', '==', classKey));
        const keySnap = await getDocs(qByKey);
        keySnap.forEach((d) => {
          collected.push({ ...(d.data() as StudentRecord), id: d.id });
        });

        if (collected.length === 0 && variants.length > 0) {
          const qByName = query(collection(db, 'students'), where('className', 'in', variants));
          const nameSnap = await getDocs(qByName);
          nameSnap.forEach((d) => {
            collected.push({ ...(d.data() as StudentRecord), id: d.id });
          });
        }
      } catch {}
    }

    if (collected.length > 0) {
      const cleaned = deduplicateAndNormalizeStudents(collected, stdName);
      saveStudentsToLocalStorage(stdName, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.warn('Không thể đọc dữ liệu học sinh từ Firestore (sử dụng offline cache):', err);
  }

  return null;
}

/**
 * Fetch class student rosters from Firestore (Admin: toàn quyền; Teacher: lọc theo permissions.ts & where())
 */
export async function fetchAllStudentsFromFirestore(userProfile?: UserPermissionsProfile | null): Promise<Record<string, StudentRecord[]>> {
  if (!db) return {};

  const allRosters: Record<string, StudentRecord[]> = {};

  try {
    await ensureFirebaseAuthSession();
    const isAdminUser = !userProfile || isAdmin(userProfile);
    const accessibleClasses = isAdminUser ? [] : getAllAccessibleClasses(userProfile);

    if (!isAdminUser && accessibleClasses.length === 0) {
      return {};
    }

    // 1. Fetch documents from 'class_rosters' collection (prefer canonical uppercase key over variant docs)
    const rostersQuery = isAdminUser
      ? collection(db, 'class_rosters')
      : query(collection(db, 'class_rosters'), where('classKey', 'in', accessibleClasses.slice(0, 30)));
    const rostersSnap = await getDocs(rostersQuery);
    const hasCanonicalRoster = new Set<string>();
    if (!rostersSnap.empty) {
      rostersSnap.forEach((docSnap) => {
        const data = docSnap.data() as any;
        const rawName = (data.className || data.name || data.classKey || data.id || docSnap.id || '').trim();
        if (rawName) {
          if (!isAdminUser && !canManageClass(userProfile, rawName)) return;
          const upperKey = normalizeClassKey(rawName) || normalizeClassKey(docSnap.id);
          if (!upperKey) return;
          const stdName = `Lớp ${upperKey}`;
          const studentList = Array.isArray(data.students)
            ? data.students
            : (Array.isArray(data.studentList) ? data.studentList : (Array.isArray(data.roster) ? data.roster : []));

          if (Array.isArray(studentList) && studentList.length > 0) {
            const cleaned = deduplicateAndNormalizeStudents(studentList as StudentRecord[], stdName);
            const isCanonicalDoc = docSnap.id === upperKey;
            const existing = allRosters[upperKey] || [];
            if (isCanonicalDoc || (!hasCanonicalRoster.has(upperKey) && cleaned.length >= existing.length)) {
              if (isCanonicalDoc) hasCanonicalRoster.add(upperKey);
              allRosters[stdName] = cleaned;
              allRosters[upperKey] = cleaned;
              try {
                localStorage.setItem(`eduplay_k5_students_${upperKey}`, JSON.stringify(cleaned));
              } catch {}
            }
          }
        }
      });
    }

    // 2. If 'students' collection exists with individual docs, fetch (filtered via where() for teacher) and merge
    try {
      const classVariants = Array.from(
        new Set(accessibleClasses.flatMap((c) => getClassKeyLookupVariants(c)).filter(Boolean))
      ).slice(0, 30);
      const studentsQuery = isAdminUser
        ? collection(db, 'students')
        : query(collection(db, 'students'), where('className', 'in', classVariants));
      const studentsSnap = await getDocs(studentsQuery);
      if (!studentsSnap.empty) {
        const individualByClass: Record<string, StudentRecord[]> = {};
        studentsSnap.forEach((d) => {
          const sData = d.data() as StudentRecord;
          const cls = sData.className || (sData as any).classKey || (sData as any).class || (sData as any).classId || (sData as any).lop;
          if (cls && (isAdminUser || canManageClass(userProfile, cls))) {
            const stdName = getStandardClassName(cls);
            if (!stdName) return;
            if (!individualByClass[stdName]) individualByClass[stdName] = [];
            individualByClass[stdName].push({ ...sData, id: d.id });
          }
        });

        Object.entries(individualByClass).forEach(([stdName, stList]) => {
          const upperKey = normalizeClassKey(stdName);
          if (!upperKey) return;
          const existing = allRosters[stdName] || [];
          // Keep existing class_rosters entries as primary; merge individual docs through deduplicateAndNormalizeStudents
          // which deduplicates by BOTH code and normalized Vietnamese name (preferring <100 & UPPERCASE)
          const cleaned = deduplicateAndNormalizeStudents([...existing, ...stList], stdName);
          allRosters[stdName] = cleaned;
          allRosters[upperKey] = cleaned;
        });
      }
    } catch {}

    // Save aggregated result to LocalStorage (browser cache only, never Firestore)
    if (Object.keys(allRosters).length > 0 && isAdminUser) {
      saveAllStudentsToLocalStorage(allRosters);
    }
  } catch (err) {
    console.warn('Lỗi tải toàn bộ học sinh từ Firestore:', err);
  }

  return allRosters;
}

/**
 * Real-time listener for a class's student roster from Firestore (read-only)
 */
export function subscribeToFirestoreClassStudents(
  className: string,
  onUpdate: (students: StudentRecord[]) => void
): () => void {
  if (!db) return () => {};

  const classKey = normalizeClassKey(className);
  if (!classKey) return () => {};
  const stdName = `Lớp ${classKey}`;
  const rosterRef = doc(db, 'class_rosters', classKey);

  const unsubscribe = onSnapshot(
    rosterRef,
    async (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const rawArr = Array.isArray(data?.students)
          ? data.students
          : (Array.isArray(data?.studentList) ? data.studentList : null);
          if (Array.isArray(rawArr) && rawArr.length > 0) {
            const cleaned = deduplicateAndNormalizeStudents(rawArr as StudentRecord[], stdName);
            saveStudentsToLocalStorage(stdName, cleaned);
            onUpdate(cleaned);
            return;
          }
          // Canonical doc explicitly exists with 0 students: clear local cache & notify
          if (Array.isArray(rawArr) && rawArr.length === 0) {
            saveStudentsToLocalStorage(stdName, []);
            onUpdate([]);
            return;
          }
        }
        if (classKey !== classKey.toLowerCase()) {
          // Read-only fallback to lowercase document if uppercase is missing
          try {
            const lowerSnap = await getDoc(doc(db, 'class_rosters', classKey.toLowerCase()));
            if (lowerSnap.exists()) {
              const data = lowerSnap.data();
              const rawArr = Array.isArray(data?.students) ? data.students : null;
              if (Array.isArray(rawArr) && rawArr.length > 0) {
                const cleaned = deduplicateAndNormalizeStudents(rawArr as StudentRecord[], stdName);
                saveStudentsToLocalStorage(stdName, cleaned);
                onUpdate(cleaned);
              }
            }
          } catch {}
        }
    },
    (error) => {
      console.warn(`Firestore onSnapshot warning for class ${className}:`, error);
    }
  );

  return unsubscribe;
}

/**
 * Load students with guaranteed persistence (LocalStorage -> Firestore -> Empty)
 */
export async function loadStudentsWithPersistence(className: string): Promise<StudentRecord[]> {
  const stdName = getStandardClassName(className);
  if (!stdName) return [];

  // 1. Try local storage first (instant synchronous)
  const localData = getStudentsFromLocalStorage(stdName);
  if (localData && localData.length > 0) {
    fetchClassStudentsFromFirestore(stdName).catch(() => {});
    return localData;
  }

  // 2. Try Firestore fetch
  const firestoreData = await fetchClassRosterSingleSource(stdName);
  if (firestoreData.students.length > 0) {
    return firestoreData.students;
  }

  // 3. No mock fallback
  return [];
}

/**
 * ============================================================================
 * SINGLE SOURCE OF TRUTH & ?debug=1 DIAGNOSTICS + SAFE MERGE PROPOSAL
 * ============================================================================
 */
export interface ClassRosterReadResult {
  classKey: string;
  className: string;
  students: StudentRecord[];
  realCount: number;
  maleCount: number;
  femaleCount: number;
  storedTotalStudents: number | null;
  hasCountMismatch: boolean;
  mismatchWarning: string | null;
  emptyReason: string | null;
  keysFound: string[];
  multiKeyWarning: string | null;
  sources: {
    firestoreClassRosters: { keys: string[]; count: number; storedTotal: number | null; male?: number; female?: number };
    firestoreStudentsCollection: { keys: string[]; count: number };
    localStorage: { keys: string[]; count: number };
    indexedDB: { note: string; rosterStored: boolean };
  };
  loadedFrom: 'firestore' | 'localStorage' | 'empty' | 'error';
  errorMessage?: string;
}

export interface ClassDebugComparisonRow {
  classKey: string;
  className: string;
  keysFound: string[];
  classRostersCount: number;
  studentsCollectionCount: number;
  localStorageCount: number;
  storedTotalStudents: number | null;
  displayedCount: number;
  multiKeyWarning: string | null;
  mismatchWarning: string | null;
  indexedDbDatabases: string[];
}

export interface MergeToStandardKeyPreview {
  classKey: string;
  className: string;
  targetDocPath: string;
  sourceDocIds: string[];
  mergedCount: number;
  existingStandardCount: number;
  studentsPreview: Array<{ stt: number; studentCode: string; name: string }>;
  fullStudents: StudentRecord[];
  willPreserveOriginals: boolean;
  willPreserveOldStt: boolean;
  batchLimit: number;
}

/**
 * Nguồn đọc ĐỒNG BỘ duy nhất dùng chung cho Đăng nhập & Quản lý người dùng.
 * Sĩ số trả về luôn là `students.length` (không lấy từ `totalStudents` lưu sẵn).
 */
export function resolveClassRosterFromMemoryAndCache(
  className: string,
  memoryDb?: Record<string, StudentRecord[]> | null
): {
  classKey: string;
  className: string;
  students: StudentRecord[];
  realCount: number;
  maleCount: number;
  femaleCount: number;
} {
  const classKey = normalizeClassKey(className);
  const stdName = classKey ? `Lớp ${classKey}` : '';
  if (!classKey || !stdName) {
    return { classKey: '', className: '', students: [], realCount: 0, maleCount: 0, femaleCount: 0 };
  }

  let rawList: StudentRecord[] | null = null;

  if (memoryDb && typeof memoryDb === 'object') {
    const directCandidates = [className, stdName, classKey, classKey.toLowerCase()];
    for (const k of directCandidates) {
      if (k && Array.isArray(memoryDb[k]) && memoryDb[k].length > 0) {
        rawList = memoryDb[k];
        break;
      }
    }
    if (!rawList) {
      for (const [k, list] of Object.entries(memoryDb)) {
        if (normalizeClassKey(k) === classKey && Array.isArray(list) && list.length > 0) {
          rawList = list;
          break;
        }
      }
    }
  }

  if (!rawList) {
    rawList = getStudentsFromLocalStorage(stdName);
  }

  const students = rawList ? deduplicateAndNormalizeStudents(rawList, stdName) : [];
  let maleCount = 0;
  let femaleCount = 0;
  students.forEach((s) => {
    const g = String(s.gender || (s as any).gioiTinh || (s as any).sex || '').trim().toLowerCase();
    if (g === 'nam' || g === 'male' || g === 'm') maleCount++;
    else if (g === 'nữ' || g === 'nu' || g === 'female' || g === 'f') femaleCount++;
  });

  return {
    classKey,
    className: stdName,
    students,
    realCount: students.length,
    maleCount,
    femaleCount
  };
}

/**
 * Nguồn đọc BẤT ĐỒNG BỘ duy nhất (CHỈ ĐỌC, KHÔNG GHI FIRESTORE) cho một lớp:
 * Quét cả khóa chuẩn + khóa biến thể trong `class_rosters`, `students`, `classes`, `localStorage`,
 * tính sĩ số thật = `students.length` và phát hiện lệch sĩ số / nguyên nhân rỗng.
 */
export async function fetchClassRosterSingleSource(
  className: string,
  userProfile?: UserPermissionsProfile | null
): Promise<ClassRosterReadResult> {
  const classKey = normalizeClassKey(className);
  const stdName = classKey ? `Lớp ${classKey}` : '';
  const emptyBase: ClassRosterReadResult = {
    classKey,
    className: stdName,
    students: [],
    realCount: 0,
    maleCount: 0,
    femaleCount: 0,
    storedTotalStudents: null,
    hasCountMismatch: false,
    mismatchWarning: null,
    emptyReason: null,
    keysFound: [],
    multiKeyWarning: null,
    sources: {
      firestoreClassRosters: { keys: [], count: 0, storedTotal: null },
      firestoreStudentsCollection: { keys: [], count: 0 },
      localStorage: { keys: [], count: 0 },
      indexedDB: { note: 'Firestore persistentLocalCache (SDK) — không chứa bảng sĩ số riêng ngoài snapshot Firestore', rosterStored: false }
    },
    loadedFrom: 'empty'
  };

  if (!classKey) {
    return { ...emptyBase, emptyReason: 'Khóa lớp không hợp lệ hoặc bị trống.' };
  }

  const keysFoundSet = new Set<string>();
  const rosterDocKeys: string[] = [];
  const studentColKeys = new Set<string>();
  const lsKeysFound: string[] = [];
  let storedTotalStudents: number | null = null;
  let storedMale: number | undefined;
  let storedFemale: number | undefined;

  const rosterStudentsCollected: StudentRecord[] = [];
  const studentsColCollected: StudentRecord[] = [];
  let errorMessage: string | undefined;

  // 1. Inspect localStorage variants (read-only)
  const localStudents = getStudentsFromLocalStorage(stdName) || [];
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('eduplay_k5_students_') && k !== EDUPLAY_STUDENTS_DB_KEY) {
          const suffix = k.replace('eduplay_k5_students_', '');
          if (normalizeClassKey(suffix) === classKey) {
            lsKeysFound.push(k);
            keysFoundSet.add(`localStorage:${suffix}`);
          }
        }
      }
    } catch {}
  }

  // 2. Inspect Firestore (STRICTLY READ-ONLY)
  if (db) {
    try {
      await ensureFirebaseAuthSession();
      const isAdminUser = !userProfile || isAdmin(userProfile);

      if (isAdminUser) {
        const rostersSnap = await getDocs(collection(db, 'class_rosters'));
        rostersSnap.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const docNormKey = normalizeClassKey(data?.classKey || data?.className || docSnap.id) || normalizeClassKey(docSnap.id);
          if (docNormKey !== classKey) return;

          rosterDocKeys.push(docSnap.id);
          keysFoundSet.add(`class_rosters/${docSnap.id}`);

          if (typeof data?.totalStudents === 'number' && (storedTotalStudents === null || docSnap.id === classKey)) {
            storedTotalStudents = data.totalStudents;
            if (typeof data?.male === 'number') storedMale = data.male;
            if (typeof data?.female === 'number') storedFemale = data.female;
          }

          const arr = Array.isArray(data?.students)
            ? data.students
            : (Array.isArray(data?.studentList) ? data.studentList : (Array.isArray(data?.roster) ? data.roster : []));
          if (Array.isArray(arr) && arr.length > 0) {
            rosterStudentsCollected.push(...(arr as StudentRecord[]));
          }
        });
      } else {
        const variantIds = Array.from(new Set([classKey, classKey.toLowerCase(), stdName, `LỚP ${classKey}`]));
        for (const docId of variantIds) {
          try {
            const snap = await getDoc(doc(db, 'class_rosters', docId));
            if (snap.exists()) {
              const data = snap.data() as any;
              rosterDocKeys.push(snap.id);
              keysFoundSet.add(`class_rosters/${snap.id}`);
              if (typeof data?.totalStudents === 'number' && (storedTotalStudents === null || snap.id === classKey)) {
                storedTotalStudents = data.totalStudents;
              }
              const arr = Array.isArray(data?.students)
                ? data.students
                : (Array.isArray(data?.studentList) ? data.studentList : []);
              if (Array.isArray(arr) && arr.length > 0) {
                rosterStudentsCollected.push(...(arr as StudentRecord[]));
              }
            }
          } catch {}
        }
      }

      // Check `public_rosters` (read-only) so keysFound and fallback stay in sync
      try {
        const pubSnap = await getDoc(doc(db, 'public_rosters', classKey));
        if (pubSnap.exists()) {
          const pData = pubSnap.data() as any;
          keysFoundSet.add(`public_rosters/${pubSnap.id}`);
          const pArr = Array.isArray(pData?.students) ? pData.students : [];
          if (rosterStudentsCollected.length === 0 && pArr.length > 0) {
            rosterStudentsCollected.push(...(pArr as StudentRecord[]));
          }
        }
      } catch {}

      // Check `classes` doc for stored totalStudents fallback if still null
      try {
        const clsSnap = await getDoc(doc(db, 'classes', classKey));
        if (clsSnap.exists()) {
          const cData = clsSnap.data() as any;
          keysFoundSet.add(`classes/${clsSnap.id}`);
          if (storedTotalStudents === null && typeof cData?.totalStudents === 'number') {
            storedTotalStudents = cData.totalStudents;
          }
        }
      } catch {}

      // Check `students` collection (read-only)
      try {
        const variants = getClassKeyLookupVariants(classKey).slice(0, 10);
        const qKeySnap = await getDocs(query(collection(db, 'students'), where('classKey', '==', classKey)));
        qKeySnap.forEach((d) => {
          const data = d.data() as StudentRecord;
          studentColKeys.add(String((data as any).classKey || data.className || classKey));
          keysFoundSet.add(`students(classKey=${(data as any).classKey || classKey})`);
          studentsColCollected.push({ ...data, id: d.id });
        });
        if (studentsColCollected.length === 0 && variants.length > 0) {
          const qNameSnap = await getDocs(query(collection(db, 'students'), where('className', 'in', variants)));
          qNameSnap.forEach((d) => {
            const data = d.data() as StudentRecord;
            studentColKeys.add(String(data.className || classKey));
            keysFoundSet.add(`students(className=${data.className || classKey})`);
            studentsColCollected.push({ ...data, id: d.id });
          });
        }
      } catch {}
    } catch (err: any) {
      errorMessage = err?.message || String(err);
    }
  } else {
    errorMessage = 'Chưa khởi tạo kết nối Cloud Firestore.';
  }

  // Merge cloud sources (prefer class_rosters + students collection), fallback to localStorage
  const cloudMergedMap = new Map<string, StudentRecord>();
  rosterStudentsCollected.forEach((s) => {
    const k = normalizeStudentCode(s.studentCode || s.code) || s.id || `${s.name}`;
    if (k) cloudMergedMap.set(k, s);
  });
  studentsColCollected.forEach((s) => {
    const k = normalizeStudentCode(s.studentCode || s.code) || s.id || `${s.name}`;
    if (k && !cloudMergedMap.has(k)) cloudMergedMap.set(k, s);
  });

  const cloudClean = deduplicateAndNormalizeStudents(Array.from(cloudMergedMap.values()), stdName);
  const localClean = deduplicateAndNormalizeStudents(localStudents, stdName);

  const finalStudents = cloudClean.length > 0 ? cloudClean : localClean;
  const loadedFrom: ClassRosterReadResult['loadedFrom'] =
    cloudClean.length > 0
      ? 'firestore'
      : localClean.length > 0
      ? 'localStorage'
      : errorMessage
      ? 'error'
      : 'empty';

  if (cloudClean.length > 0) {
    saveStudentsToLocalStorage(stdName, cloudClean);
  }

  const realCount = finalStudents.length;
  let maleCount = 0;
  let femaleCount = 0;
  finalStudents.forEach((s) => {
    const g = String(s.gender || (s as any).gioiTinh || (s as any).sex || '').trim().toLowerCase();
    if (g === 'nam' || g === 'male' || g === 'm') maleCount++;
    else if (g === 'nữ' || g === 'nu' || g === 'female' || g === 'f') femaleCount++;
  });

  const hasCountMismatch = storedTotalStudents !== null && storedTotalStudents !== realCount;
  const mismatchWarning = hasCountMismatch
    ? `Sĩ số ghi ${storedTotalStudents} nhưng danh sách có ${realCount} học sinh`
    : null;

  let emptyReason: string | null = null;
  if (realCount === 0) {
    if (errorMessage) {
      emptyReason = `Lỗi truy vấn Firestore: ${errorMessage}`;
    } else if (typeof window !== 'undefined' && (localStorage.getItem(`eduplay_k5_cleared_${classKey}`) === 'true' || localStorage.getItem(`eduplay_k5_cleared_${classKey.toLowerCase()}`) === 'true')) {
      emptyReason = `Lớp ${stdName} đã bị đánh dấu xóa danh sách cục bộ (eduplay_k5_cleared_${classKey})`;
    } else if (storedTotalStudents && storedTotalStudents > 0) {
      emptyReason = `Tài liệu Firestore ghi sĩ số ${storedTotalStudents} nhưng mảng students rỗng và không có hồ sơ trong collection students`;
    } else if (rosterDocKeys.length === 0) {
      emptyReason = `Chưa có tài liệu class_rosters/${classKey} trên Firestore và chưa có dữ liệu trong bộ nhớ trình duyệt`;
    } else {
      emptyReason = `Tài liệu class_rosters/${rosterDocKeys.join(', ')} hiện chưa có phần tử học sinh nào`;
    }
  }

  const normalizedDistinctRosterIds = new Set(rosterDocKeys);
  const multiKeyWarning =
    normalizedDistinctRosterIds.size > 1 || (normalizedDistinctRosterIds.size === 1 && !normalizedDistinctRosterIds.has(classKey))
      ? `Phát hiện khóa không chuẩn/nhiều khóa cho ${stdName}: ${Array.from(keysFoundSet).join(', ')}`
      : null;

  return {
    classKey,
    className: stdName,
    students: finalStudents,
    realCount,
    maleCount,
    femaleCount,
    storedTotalStudents,
    hasCountMismatch,
    mismatchWarning,
    emptyReason,
    keysFound: Array.from(keysFoundSet),
    multiKeyWarning,
    sources: {
      firestoreClassRosters: {
        keys: rosterDocKeys,
        count: deduplicateAndNormalizeStudents(rosterStudentsCollected, stdName).length,
        storedTotal: storedTotalStudents,
        male: storedMale,
        female: storedFemale
      },
      firestoreStudentsCollection: {
        keys: Array.from(studentColKeys),
        count: deduplicateAndNormalizeStudents(studentsColCollected, stdName).length
      },
      localStorage: {
        keys: lsKeysFound,
        count: localClean.length
      },
      indexedDB: {
        note: 'Firestore persistentLocalCache (SDK)',
        rosterStored: false
      }
    },
    loadedFrom,
    errorMessage
  };
}

/**
 * Quét CHỈ ĐỌC toàn bộ các lớp cho bảng so sánh `?debug=1`.
 * Hiển thị: khóa tìm thấy, số HS ở mỗi nơi lưu (class_rosters, students, localStorage), số hiển thị thật và cảnh báo.
 */
export async function scanAllClassesComparisonForDebug(
  userProfile?: UserPermissionsProfile | null
): Promise<ClassDebugComparisonRow[]> {
  const byClass = new Map<
    string,
    {
      keysFound: Set<string>;
      rosterStudents: StudentRecord[];
      studentsCol: StudentRecord[];
      storedTotalStudents: number | null;
      rosterDocCount: number;
    }
  >();

  const ensureEntry = (key: string) => {
    if (!byClass.has(key)) {
      byClass.set(key, {
        keysFound: new Set<string>(),
        rosterStudents: [],
        studentsCol: [],
        storedTotalStudents: null,
        rosterDocCount: 0
      });
    }
    return byClass.get(key)!;
  };

  let indexedDbNames: string[] = [];
  if (typeof window !== 'undefined' && window.indexedDB && typeof (window.indexedDB as any).databases === 'function') {
    try {
      const dbs = await (window.indexedDB as any).databases();
      if (Array.isArray(dbs)) {
        indexedDbNames = dbs.map((d: any) => d?.name).filter(Boolean);
      }
    } catch {}
  }

  // Always seed 5C & 5D so they appear even if empty
  ensureEntry('5C');
  ensureEntry('5D');

  if (db) {
    try {
      await ensureFirebaseAuthSession();
      const isAdminUser = !userProfile || isAdmin(userProfile);

      if (isAdminUser) {
        const [classesSnap, rostersSnap, studentsSnap] = await Promise.all([
          getDocs(collection(db, 'classes')),
          getDocs(collection(db, 'class_rosters')),
          getDocs(collection(db, 'students'))
        ]);

        classesSnap.forEach((d) => {
          const data = d.data() as any;
          const k = normalizeClassKey(data?.name || data?.className || d.id) || normalizeClassKey(d.id);
          if (!k) return;
          const entry = ensureEntry(k);
          entry.keysFound.add(`classes/${d.id}`);
          if (entry.storedTotalStudents === null && typeof data?.totalStudents === 'number') {
            entry.storedTotalStudents = data.totalStudents;
          }
        });

        rostersSnap.forEach((d) => {
          const data = d.data() as any;
          const k = normalizeClassKey(data?.classKey || data?.className || d.id) || normalizeClassKey(d.id);
          if (!k) return;
          const entry = ensureEntry(k);
          entry.rosterDocCount += 1;
          entry.keysFound.add(`class_rosters/${d.id}`);
          if (typeof data?.totalStudents === 'number' && (entry.storedTotalStudents === null || d.id === k)) {
            entry.storedTotalStudents = data.totalStudents;
          }
          const arr = Array.isArray(data?.students)
            ? data.students
            : (Array.isArray(data?.studentList) ? data.studentList : []);
          if (Array.isArray(arr)) {
            entry.rosterStudents.push(...(arr as StudentRecord[]));
          }
        });

        studentsSnap.forEach((d) => {
          const data = d.data() as any;
          const rawCls = data?.classKey || data?.className || data?.class || data?.classId || data?.lop;
          const k = normalizeClassKey(rawCls);
          if (!k) return;
          const entry = ensureEntry(k);
          if (rawCls) entry.keysFound.add(`students:${String(rawCls)}`);
          entry.studentsCol.push({ ...data, id: d.id });
        });
      }
    } catch (err) {
      console.warn('Lỗi quét ?debug=1 từ Firestore:', err);
    }
  }

  // Scan localStorage
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const lsKey = localStorage.key(i);
        if (lsKey && lsKey.startsWith('eduplay_k5_students_') && lsKey !== EDUPLAY_STUDENTS_DB_KEY) {
          const suffix = lsKey.replace('eduplay_k5_students_', '');
          const k = normalizeClassKey(suffix);
          if (!k) continue;
          const entry = ensureEntry(k);
          entry.keysFound.add(`ls:${suffix}`);
        }
      }
      const rawFull = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
      if (rawFull) {
        const parsed = JSON.parse(rawFull);
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach((rawK) => {
            const k = normalizeClassKey(rawK);
            if (!k) return;
            ensureEntry(k).keysFound.add(`ls_db:${rawK}`);
          });
        }
      }
    } catch {}
  }

  const rows: ClassDebugComparisonRow[] = [];
  byClass.forEach((entry, classKey) => {
    const className = `Lớp ${classKey}`;
    const rosterCleanCount = deduplicateAndNormalizeStudents(entry.rosterStudents, className).length;
    const studentsColCleanCount = deduplicateAndNormalizeStudents(entry.studentsCol, className).length;
    const lsResolved = getStudentsFromLocalStorage(className) || [];
    const localStorageCount = lsResolved.length;

    const mergedCloud = new Map<string, StudentRecord>();
    entry.rosterStudents.forEach((s) => {
      const id = normalizeStudentCode(s.studentCode || s.code) || s.id || s.name;
      if (id) mergedCloud.set(id, s);
    });
    entry.studentsCol.forEach((s) => {
      const id = normalizeStudentCode(s.studentCode || s.code) || s.id || s.name;
      if (id && !mergedCloud.has(id)) mergedCloud.set(id, s);
    });
    const cloudClean = deduplicateAndNormalizeStudents(Array.from(mergedCloud.values()), className);
    const displayedCount = cloudClean.length > 0 ? cloudClean.length : localStorageCount;

    const rosterOnlyKeys = Array.from(entry.keysFound).filter((k) => k.startsWith('class_rosters/'));
    const hasNonCanonicalRosterKey = rosterOnlyKeys.some((k) => k !== `class_rosters/${classKey}`);
    const multiKeyWarning =
      rosterOnlyKeys.length > 1 || hasNonCanonicalRosterKey
        ? `Phát hiện ${rosterOnlyKeys.length} khóa class_rosters (${rosterOnlyKeys.join(', ')})`
        : null;

    const mismatchWarning =
      entry.storedTotalStudents !== null && entry.storedTotalStudents !== displayedCount
        ? `Sĩ số ghi ${entry.storedTotalStudents} nhưng danh sách có ${displayedCount} học sinh`
        : null;

    rows.push({
      classKey,
      className,
      keysFound: Array.from(entry.keysFound),
      classRostersCount: rosterCleanCount,
      studentsCollectionCount: studentsColCleanCount,
      localStorageCount,
      storedTotalStudents: entry.storedTotalStudents,
      displayedCount,
      multiKeyWarning,
      mismatchWarning,
      indexedDbDatabases: indexedDbNames
    });
  });

  rows.sort((a, b) => a.classKey.localeCompare(b.classKey, 'vi', { numeric: true }));
  return rows;
}

/**
 * ĐỀ XUẤT KHÔI PHỤC (CHỈ XEM TRƯỚC - KHÔNG TỰ CHẠY):
 * Gom các biến thể khóa của 1 lớp (vd `5d`, `Lớp 5D`, `students`) về khóa chuẩn `class_rosters/{KEY}`
 * giữ nguyên bản gốc và giữ nguyên số thứ tự / mã HS cũ.
 */
export async function previewMergeClassToStandardKey(
  classKeyOrName: string
): Promise<MergeToStandardKeyPreview> {
  const classKey = normalizeClassKey(classKeyOrName);
  const className = `Lớp ${classKey}`;
  if (!db || !classKey) {
    throw new Error('Firestore chưa sẵn sàng hoặc mã lớp không hợp lệ.');
  }

  await ensureFirebaseAuthSession();
  const [rostersSnap, studentsSnap] = await Promise.all([
    getDocs(collection(db, 'class_rosters')),
    getDocs(collection(db, 'students'))
  ]);

  const sourceDocIds: string[] = [];
  let existingStandardCount = 0;
  const mergedMap = new Map<string, StudentRecord>();

  rostersSnap.forEach((docSnap) => {
    const data = docSnap.data() as any;
    const norm = normalizeClassKey(data?.classKey || data?.className || docSnap.id) || normalizeClassKey(docSnap.id);
    if (norm !== classKey) return;
    sourceDocIds.push(`class_rosters/${docSnap.id}`);
    const arr = Array.isArray(data?.students) ? data.students : (Array.isArray(data?.studentList) ? data.studentList : []);
    if (docSnap.id === classKey) {
      existingStandardCount = arr.length;
    }
    arr.forEach((s: any) => {
      const codeKey = normalizeStudentCode(s?.studentCode || s?.code) || String(s?.id || s?.name || '');
      if (codeKey && !mergedMap.has(codeKey)) {
        mergedMap.set(codeKey, s as StudentRecord);
      }
    });
  });

  studentsSnap.forEach((docSnap) => {
    const data = docSnap.data() as any;
    const norm = normalizeClassKey(data?.classKey || data?.className || data?.class || data?.classId);
    if (norm !== classKey) return;
    const codeKey = normalizeStudentCode(data?.studentCode || data?.code) || docSnap.id;
    if (codeKey && !mergedMap.has(codeKey)) {
      sourceDocIds.push(`students/${docSnap.id}`);
      mergedMap.set(codeKey, { ...(data as StudentRecord), id: docSnap.id });
    }
  });

  const fullStudents = deduplicateAndNormalizeStudents(Array.from(mergedMap.values()), className);
  return {
    classKey,
    className,
    targetDocPath: `class_rosters/${classKey}`,
    sourceDocIds: Array.from(new Set(sourceDocIds)),
    mergedCount: fullStudents.length,
    existingStandardCount,
    studentsPreview: fullStudents.slice(0, 10).map((s) => ({
      stt: s.stt || 0,
      studentCode: s.studentCode || s.code || '',
      name: s.name || s.fullName || ''
    })),
    fullStudents,
    willPreserveOriginals: true,
    willPreserveOldStt: true,
    batchLimit: 500
  };
}

/**
 * Thực thi gộp về khóa chuẩn CHỈ KHI Admin xác nhận (writeBatch tối đa 500, không xóa bản gốc, giữ STT cũ).
 */
export async function executeMergeClassToStandardKey(
  preview: MergeToStandardKeyPreview
): Promise<{ success: boolean; message: string; mergedCount: number }> {
  if (!db) return { success: false, message: 'Chưa khởi tạo Firestore.', mergedCount: 0 };
  if (!preview || preview.fullStudents.length === 0) {
    return { success: false, message: 'Không có học sinh nào để gộp.', mergedCount: 0 };
  }

  try {
    await ensureFirebaseAuthSession();
    const nowIso = new Date().toISOString();
    const male = preview.fullStudents.filter((s) => s.gender === 'Nam').length;
    const female = preview.fullStudents.filter((s) => s.gender === 'Nữ').length;
    const safeClassKey = sanitizeFirestoreDocId(preview.classKey, preview.classKey);

    const CHUNK_SIZE = 499; // writeBatch tối đa 500 ops (1 roster doc + <=499 student docs)
    const firstChunk = preview.fullStudents.slice(0, CHUNK_SIZE);
    const firstBatch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
    firstBatch.set(
      doc(db, 'class_rosters', safeClassKey),
      sanitizeForFirestore({
        classKey: preview.classKey,
        className: preview.className,
        grade: 'Khối 5',
        totalStudents: preview.fullStudents.length,
        male,
        female,
        students: preview.fullStudents,
        mergedFromSources: preview.sourceDocIds,
        updatedAt: nowIso
      }),
      { merge: true }
    );
    firstChunk.forEach((st) => {
      const docId = sanitizeFirestoreDocId(st.studentCode || st.code || st.id, `st_${safeClassKey}`);
      firstBatch.set(
        doc(db, 'students', docId),
        sanitizeForFirestore({
          ...st,
          classKey: preview.classKey,
          className: preview.className,
          updatedAt: nowIso
        }),
        { merge: true }
      );
    });
    await firstBatch.commit();

    for (let i = CHUNK_SIZE; i < preview.fullStudents.length; i += 500) {
      const chunk = preview.fullStudents.slice(i, i + 500);
      const batch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
      chunk.forEach((st) => {
        const docId = sanitizeFirestoreDocId(st.studentCode || st.code || st.id, `st_${safeClassKey}`);
        batch.set(
          doc(db, 'students', docId),
          sanitizeForFirestore({
            ...st,
            classKey: preview.classKey,
            className: preview.className,
            updatedAt: nowIso
          }),
          { merge: true }
        );
      });
      await batch.commit();
    }

    saveStudentsToLocalStorage(preview.className, preview.fullStudents);
    return {
      success: true,
      message: `Đã gộp ${preview.fullStudents.length} học sinh về khóa chuẩn ${preview.targetDocPath} (giữ nguyên bản gốc & STT cũ).`,
      mergedCount: preview.fullStudents.length
    };
  } catch (err: any) {
    const details = extractFirestoreErrorDetails(err);
    return { success: false, message: details.message, mergedCount: 0 };
  }
}

/**
 ============================================================================
 STUDENT ENROLLMENTS & ACTIVE ACADEMIC YEAR MANAGEMENT (VIỆC 3)
 ============================================================================
 */
export const EDUPLAY_CURRENT_ACADEMIC_YEAR_KEY = 'eduplay_k5_current_academic_year';
export const EDUPLAY_CURRENT_SEMESTER_KEY = 'eduplay_k5_current_semester';
export const EDUPLAY_STUDENT_ENROLLMENTS_KEY = 'eduplay_k5_student_enrollments_db';

export function getCurrentActiveAcademicYear(): string {
  if (typeof window === 'undefined') return '2026-2027';
  try {
    return localStorage.getItem(EDUPLAY_CURRENT_ACADEMIC_YEAR_KEY) || '2026-2027';
  } catch {
    return '2026-2027';
  }
}

export function getCurrentSelectedSemester(): string {
  if (typeof window === 'undefined') return 'Học kỳ I';
  try {
    return localStorage.getItem(EDUPLAY_CURRENT_SEMESTER_KEY) || 'Học kỳ I';
  } catch {
    return 'Học kỳ I';
  }
}

export function setActiveAcademicYear(year: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(EDUPLAY_CURRENT_ACADEMIC_YEAR_KEY, year.trim());
    window.dispatchEvent(new CustomEvent('eduplay_k5_academic_year_updated', { detail: { academicYear: year.trim() } }));
  } catch {}
}

export function setSelectedSemester(semester: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(EDUPLAY_CURRENT_SEMESTER_KEY, semester.trim());
    window.dispatchEvent(new CustomEvent('eduplay_k5_semester_updated', { detail: { semester: semester.trim() } }));
    window.dispatchEvent(new CustomEvent('eduplay_k5_period_updated', { detail: { semester: semester.trim() } }));
  } catch {}
}

export function setAcademicPeriod(year: string, semester: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(EDUPLAY_CURRENT_ACADEMIC_YEAR_KEY, year.trim());
    localStorage.setItem(EDUPLAY_CURRENT_SEMESTER_KEY, semester.trim());
    window.dispatchEvent(new CustomEvent('eduplay_k5_academic_year_updated', { detail: { academicYear: year.trim() } }));
    window.dispatchEvent(new CustomEvent('eduplay_k5_semester_updated', { detail: { semester: semester.trim() } }));
    window.dispatchEvent(new CustomEvent('eduplay_k5_period_updated', { detail: { academicYear: year.trim(), semester: semester.trim() } }));
  } catch {}
}

export function getAllStudentEnrollments(): StudentEnrollmentRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(EDUPLAY_STUDENT_ENROLLMENTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function saveStudentEnrollments(enrollments: StudentEnrollmentRecord[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(EDUPLAY_STUDENT_ENROLLMENTS_KEY, JSON.stringify(enrollments));
    window.dispatchEvent(new CustomEvent('eduplay_k5_enrollments_updated'));
  } catch {}
}

/**
 * Utility to extract normalized classId (e.g. "5D") without "Lớp" prefix
 */
export function extractClassId(classNameOrId: string): string {
  if (!classNameOrId) return '5C';
  return normalizeClassKey(classNameOrId);
}

export function upsertStudentEnrollment(
  record: StudentEnrollmentRecord,
  options?: { writeToFirestore?: boolean; isUserInitiated?: boolean }
): void {
  if (!record || !record.sddcn || !record.academicYear) return;

  const normalizedClassId = extractClassId(record.classId || record.className || '1A');
  const normalizedClassName = record.className && record.className.toLowerCase().includes('lớp')
    ? record.className
    : getStandardClassName(normalizedClassId);

  const cleanRecord: StudentEnrollmentRecord = {
    ...record,
    classId: normalizedClassId,
    className: normalizedClassName
  };

  const all = getAllStudentEnrollments();
  const existingIdx = all.findIndex(e => e.sddcn === cleanRecord.sddcn && e.academicYear === cleanRecord.academicYear);

  let isDifferent = true;
  if (existingIdx >= 0) {
    const prev = all[existingIdx];
    if (
      prev.classId === cleanRecord.classId &&
      prev.className === cleanRecord.className &&
      prev.displayCode === cleanRecord.displayCode
    ) {
      isDifferent = false;
    }
    all[existingIdx] = cleanRecord;
  } else {
    all.push(cleanRecord);
  }

  saveStudentEnrollments(all);

  // Only write to Firestore when explicitly requested (e.g. user/admin action) AND data changed
  if (options?.writeToFirestore && isDifferent && db) {
    const docId = `${cleanRecord.sddcn}_${cleanRecord.academicYear}`;
    trackedSetDoc(
      doc(db, 'student_enrollments', docId),
      cleanRecord,
      { merge: true },
      { isUserInitiated: options?.isUserInitiated ?? true, actionType: 'admin_batch' }
    ).catch(() => {});
  }
}

export function getStudentClassInfo(sddcn: string, academicYear?: string): { className: string; displayCode: string; classId: string; academicYear: string } | null {
  if (!sddcn) return null;
  const targetYear = academicYear || getCurrentActiveAcademicYear();
  const all = getAllStudentEnrollments();
  const found = all.find(e => e.sddcn === sddcn && e.academicYear === targetYear);
  if (found) {
    const classId = extractClassId(found.classId || found.className || '5C');
    const className = found.className || getStandardClassName(classId);
    return {
      className,
      displayCode: found.displayCode || '',
      classId,
      academicYear: found.academicYear
    };
  }
  return null;
}

export function promoteStudentToNextYear(
  sddcn: string,
  newClassId: string,
  newAcademicYear: string,
  newDisplayCode?: string
): void {
  if (!sddcn || !newClassId || !newAcademicYear) return;
  const normalizedClassId = extractClassId(newClassId);
  const record: StudentEnrollmentRecord = {
    sddcn,
    academicYear: newAcademicYear,
    classId: normalizedClassId,
    className: getStandardClassName(normalizedClassId),
    displayCode: newDisplayCode || '01'
  };
  upsertStudentEnrollment(record, { writeToFirestore: true, isUserInitiated: true });
}

/**
 * Admin action: Initialize or sync student enrollments for an academic year using writeBatch (max 500 ops)
 */
export async function initializeStudentEnrollmentsForYear(
  academicYear: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ success: boolean; totalProcessed: number; errors: string[] }> {
  if (!db) return { success: false, totalProcessed: 0, errors: ['Firestore chưa khởi tạo'] };

  try {
    const flagRef = doc(db, 'system_settings', `enrollment_init_${academicYear}`);
    const flagSnap = await getDoc(flagRef);
    if (flagSnap.exists() && flagSnap.data()?.isInitialized) {
      console.log(`ℹ️ Năm học ${academicYear} đã được khởi tạo hồ sơ student_enrollments trước đó.`);
    }

    const allRosters = await fetchAllStudentsFromFirestore();
    const recordsToInsert: StudentEnrollmentRecord[] = [];

    Object.entries(allRosters).forEach(([className, stList]) => {
      const classId = extractClassId(className);
      const stdClassName = getStandardClassName(classId);

      stList.forEach((st) => {
        if (st.sddcn) {
          recordsToInsert.push({
            sddcn: st.sddcn,
            academicYear: st.academicYear || academicYear,
            classId,
            className: stdClassName,
            displayCode: st.code || st.id || '01'
          });
        }
      });
    });

    if (recordsToInsert.length === 0) {
      return { success: true, totalProcessed: 0, errors: [] };
    }

    const BATCH_SIZE = 450;
    let processed = 0;
    const errors: string[] = [];

    for (let i = 0; i < recordsToInsert.length; i += BATCH_SIZE) {
      const chunk = recordsToInsert.slice(i, i + BATCH_SIZE);
      const batch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });

      chunk.forEach((rec) => {
        upsertStudentEnrollment(rec, { writeToFirestore: false });
        const docId = `${rec.sddcn}_${rec.academicYear}`;
        const ref = doc(db, 'student_enrollments', docId);
        batch.set(ref, rec, { merge: true });
      });

      try {
        await batch.commit();
        processed += chunk.length;
        if (onProgress) onProgress(processed, recordsToInsert.length);
      } catch (err: any) {
        errors.push(`Lỗi ghi batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err?.message || String(err)}`);
      }
    }

    await trackedSetDoc(
      flagRef,
      {
        isInitialized: true,
        academicYear,
        totalStudents: recordsToInsert.length,
        updatedAt: new Date().toISOString()
      },
      { merge: true },
      { isUserInitiated: true, actionType: 'admin_batch' }
    );

    return { success: errors.length === 0, totalProcessed: processed, errors };
  } catch (err: any) {
    return { success: false, totalProcessed: 0, errors: [err?.message || String(err)] };
  }
}

/**
 * Admin proposal utility: Scan student_enrollments for unnormalized classId (e.g. "Lớp 5D" -> "5D")
 */
export function previewAndProposeClassIdNormalization(): {
  needsUpdate: boolean;
  totalRecords: number;
  recordsNeedingFix: number;
  sampleFixes: Array<{ sddcn: string; oldClassId: string; newClassId: string; className: string }>;
} {
  const enrollments = getAllStudentEnrollments();
  const needingFix: Array<{ sddcn: string; oldClassId: string; newClassId: string; className: string }> = [];

  for (const e of enrollments) {
    const extracted = extractClassId(e.classId || e.className || '');
    if (e.classId !== extracted) {
      needingFix.push({
        sddcn: e.sddcn,
        oldClassId: e.classId || '',
        newClassId: extracted,
        className: e.className || getStandardClassName(extracted)
      });
    }
  }

  return {
    needsUpdate: needingFix.length > 0,
    totalRecords: enrollments.length,
    recordsNeedingFix: needingFix.length,
    sampleFixes: needingFix.slice(0, 5)
  };
}

/**
 * Kiểm tra xem năm học đã có dữ liệu phân lớp (student_enrollments) chưa
 */
export function hasStudentEnrollmentsForYear(year: string): boolean {
  if (!year) return false;
  const currentActive = getCurrentActiveAcademicYear();
  // Năm học mặc định 2026-2027 có sẵn dữ liệu học sinh trong các bảng lớp cơ bản
  if (year === '2026-2027' && (year === currentActive || currentActive === '2026-2027')) {
    return true;
  }
  const enrollments = getAllStudentEnrollments();
  return enrollments.some(e => e.academicYear === year);
}

/**
 * Lấy danh sách hồ sơ phân lớp của một năm học
 */
export function getStudentEnrollmentsForYear(year: string): StudentEnrollmentRecord[] {
  if (!year) return [];
  const enrollments = getAllStudentEnrollments();
  return enrollments.filter(e => e.academicYear === year);
}

/**
 * Lấy danh mục các năm học khả dụng trong hệ thống
 */
export function getAvailableAcademicYears(): string[] {
  const currentActive = getCurrentActiveAcademicYear();
  const set = new Set<string>();
  set.add('2026-2027');
  set.add('2027-2028');
  if (currentActive) set.add(currentActive);
  const enrollments = getAllStudentEnrollments();
  enrollments.forEach(e => {
    if (e.academicYear) set.add(e.academicYear);
  });
  return Array.from(set).sort();
}

/**
 * Lấy thông tin trạng thái của một năm học: Đang hoạt động, Đang chuẩn bị, hoặc Lưu trữ
 */
export function getAcademicYearStatus(year: string): {
  isActive: boolean;
  hasData: boolean;
  label: string;
  badgeClass: string;
  dotColor: string;
  statusType: 'active' | 'preparing' | 'archived';
} {
  const currentActive = getCurrentActiveAcademicYear();
  const isActive = year === currentActive;
  const hasData = hasStudentEnrollmentsForYear(year);

  if (isActive) {
    return {
      isActive: true,
      hasData: true,
      label: 'Năm học đang hoạt động',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      dotColor: 'bg-emerald-500',
      statusType: 'active'
    };
  }

  if (!hasData) {
    return {
      isActive: false,
      hasData: false,
      label: 'Năm học đang chuẩn bị',
      badgeClass: 'bg-amber-50 text-amber-800 border-amber-300',
      dotColor: 'bg-amber-500',
      statusType: 'preparing'
    };
  }

  return {
    isActive: false,
    hasData: true,
    label: 'Năm học lưu trữ',
    badgeClass: 'bg-slate-50 text-slate-600 border-slate-200',
    dotColor: 'bg-slate-400',
    statusType: 'archived'
  };
}

/**
 * Điều hướng trực tiếp tới quy trình Lên Lớp Cuối Năm (Quản lý người dùng -> Tab promotion)
 */
export function navigateToPromotionTab(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('eduplay_k5_open_user_tab', 'promotion');
    window.dispatchEvent(new CustomEvent('eduplay_k5_open_promotion_tab'));
    window.dispatchEvent(new CustomEvent('eduplay_k5_navigate_module', { detail: { module: 'user_management' } }));
  } catch {}
}

/**
 * ============================================================================
 * LƯU TRỮ VÀ ĐỒNG BỘ TRẠNG THÁI "KẾT QUẢ CUỐI NĂM" / LÊN LỚP CUỐI NĂM
 * ============================================================================
 */
export type YearEndPromotionStatus = 'promoted' | 'review_needed' | 'retained';

export interface YearEndResultRecord {
  sddcn: string;
  academicYear: string;
  status: YearEndPromotionStatus; // 'promoted' (Lên lớp) | 'review_needed' (Cần xem xét) | 'retained' (Ở lại lớp)
  note?: string;
  autoRating?: string; // Ví dụ: "Hoàn thành Xuất sắc", "Hoàn thành Tốt", "Hoàn thành", "Chưa hoàn thành"
  isManualConfirmed?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export const EDUPLAY_YEAR_END_RESULTS_KEY = 'eduplay_k5_year_end_results';

export function getAllYearEndResults(): Record<string, YearEndResultRecord> {
  if (typeof window === 'undefined') return {};
  try {
    const saved = localStorage.getItem(EDUPLAY_YEAR_END_RESULTS_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
}

export function getYearEndResult(sddcn: string, academicYear: string): YearEndResultRecord | null {
  if (!sddcn || !academicYear) return null;
  const all = getAllYearEndResults();
  const key = `${sddcn}_${academicYear}`;
  return all[key] || null;
}

export function saveYearEndResult(record: YearEndResultRecord): void {
  if (!record || !record.sddcn || !record.academicYear) return;
  const all = getAllYearEndResults();
  const key = `${record.sddcn}_${record.academicYear}`;
  all[key] = {
    ...record,
    updatedAt: new Date().toISOString()
  };

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(EDUPLAY_YEAR_END_RESULTS_KEY, JSON.stringify(all));
      window.dispatchEvent(new CustomEvent('eduplay_k5_year_end_results_updated', { detail: { record } }));
    } catch {}
  }

  if (db) {
    trackedSetDoc(doc(db, 'student_year_end_results', key), record, { merge: true }).catch(() => {});
  }
}


