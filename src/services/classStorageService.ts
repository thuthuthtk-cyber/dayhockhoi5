import { collection, doc, onSnapshot, getDocs } from 'firebase/firestore';
import { signInAnonymously } from 'firebase/auth';
import { db, auth, ensureFirebaseAuthSessionWithStatus } from '../firebaseConfig';
import { trackedSetDoc, extractFirestoreErrorDetails } from './firestoreWriteTracker';
import { sanitizeForFirestore, sanitizeFirestoreDocId } from '../utils/firestoreSanitizer';
import { useState, useEffect, useMemo } from 'react';
// import { safeStorage } from '../utils/safeStorage';

export interface ClassSubjectConfig {
  isVisible: boolean;
  subjectName: string;
}

export interface SchoolClassItem {
  id: string;
  name: string;      // e.g. "Lớp 1C", "Lớp 5D"
  grade: string;     // e.g. "Khối 1", "Khối 5"
  room?: string;     // e.g. "Phòng 101"
  homeroomTeacher?: string;
  subjects?: ClassSubjectConfig[];
}

/**
 * Danh sách môn học tiêu chuẩn theo từng Khối lớp Tiểu học (Chương trình GDPT 2018)
 */
export const STANDARD_GRADE_SUBJECTS: Record<string, string[]> = {
  'Khối 5': ['Toán', 'Tiếng Việt', 'Tiếng Anh', 'Tin học', 'Công nghệ', 'Khoa học', 'Lịch sử và Địa lí', 'Đạo đức', 'Âm nhạc', 'Mĩ thuật', 'Giáo dục thể chất', 'Hoạt động trải nghiệm'],
  'Khối 4': ['Toán', 'Tiếng Việt', 'Tiếng Anh', 'Tin học', 'Công nghệ', 'Khoa học', 'Lịch sử và Địa lí', 'Đạo đức', 'Âm nhạc', 'Mĩ thuật', 'Giáo dục thể chất', 'Hoạt động trải nghiệm'],
  'Khối 3': ['Toán', 'Tiếng Việt', 'Tiếng Anh', 'Tin học', 'Công nghệ', 'Tự nhiên và Xã hội', 'Đạo đức', 'Âm nhạc', 'Mĩ thuật', 'Giáo dục thể chất', 'Hoạt động trải nghiệm']
};

// Default classes (chỉ giữ lại Khối 5: 5C, 5D)
export const REAL_SCHOOL_CLASSES_FALLBACK: SchoolClassItem[] = [
  { id: '5C', name: 'Lớp 5C', grade: 'Khối 5', room: 'Phòng 503', subjects: STANDARD_GRADE_SUBJECTS['Khối 5'].map(s => ({ isVisible: true, subjectName: s })) },
  { id: '5D', name: 'Lớp 5D', grade: 'Khối 5', room: 'Phòng 504', subjects: STANDARD_GRADE_SUBJECTS['Khối 5'].map(s => ({ isVisible: true, subjectName: s })) }
];

const isExcludedClassKey = (key: string): boolean => /^5[AB](\d+)?$/i.test((key || '').trim());

/**
 * Chuẩn hóa khóa lớp học:
 * Bỏ mọi tiền tố "Lớp"/"LỚP" lặp lại ở đầu, viết hoa, bỏ khoảng trắng thừa
 * Ví dụ: "Lớp LỚP 3C", "LỚP 3C", " lớp  3c ", "3C" -> "3C"
 */
export function normalizeClassKeyStrict(rawName?: string): string {
  if (!rawName) return '';
  let s = String(rawName).trim().replace(/\s+/g, ' ');
  while (/^(lớp|lop)\b[\s:_-]*/i.test(s)) {
    s = s.replace(/^(lớp|lop)\b[\s:_-]*/i, '').trim();
  }
  return s.replace(/\s+/g, '').toUpperCase();
}

/**
 * Hàm chuẩn hóa khóa lớp dùng chung cho toàn bộ hệ thống (đọc & ghi)
 */
export const normalizeClassKey = normalizeClassKeyStrict;

/**
 * Trả về các biến thể khóa lớp để đọc dự phòng (chỉ đọc, không tự ghi)
 */
export function getClassKeyLookupVariants(rawName?: string): string[] {
  const key = normalizeClassKeyStrict(rawName);
  if (!key) return [];
  const lower = key.toLowerCase();
  const variants = new Set<string>([
    key,
    lower,
    `Lớp ${key}`,
    `Lớp ${lower}`,
    `LỚP ${key}`,
    `lớp ${lower}`,
    `Lop ${key}`,
    `lop ${lower}`
  ]);
  if (rawName && rawName.trim()) {
    variants.add(rawName.trim());
  }
  return Array.from(variants);
}

/**
 * Format class name string uniformly to "Lớp 3C" (never "Lớp LỚP 3C")
 */
export function formatClassName(rawName?: string): string {
  if (!rawName) return '';
  const key = normalizeClassKeyStrict(rawName);
  if (!key) return '';
  return `Lớp ${key}`;
}

/**
 * Deduplicate and normalize an array of class items in-memory (read-only on Firestore)
 */
export function deduplicateClassItems(items: SchoolClassItem[]): SchoolClassItem[] {
  const classMap = new Map<string, SchoolClassItem>();
  items.forEach((item) => {
    if (!item) return;
    const rawName = (item.name || item.id || '').trim();
    const rawId = (item.id || '').trim();
    const normalizedKey = normalizeClassKeyStrict(rawName) || normalizeClassKeyStrict(rawId);
    if (!normalizedKey || isExcludedClassKey(normalizedKey)) return;

    const digit = extractGradeDigit(item.grade) || extractGradeDigit(normalizedKey);
    if (digit !== '5') return;

    const stdName = `Lớp ${normalizedKey}`;
    const normalizedItem: SchoolClassItem = {
      ...item,
      id: normalizedKey,
      name: stdName,
      grade: 'Khối 5',
      subjects: Array.isArray(item.subjects) && item.subjects.length > 0
        ? item.subjects
        : STANDARD_GRADE_SUBJECTS['Khối 5'].map(s => ({ isVisible: true, subjectName: s }))
    };

    if (classMap.has(normalizedKey)) {
      const existing = classMap.get(normalizedKey)!;
      classMap.set(normalizedKey, {
        ...existing,
        id: normalizedKey,
        name: stdName,
        grade: 'Khối 5',
        room: existing.room || normalizedItem.room,
        homeroomTeacher: existing.homeroomTeacher || normalizedItem.homeroomTeacher,
        subjects: (existing.subjects && existing.subjects.length > 0) ? existing.subjects : normalizedItem.subjects
      });
    } else {
      classMap.set(normalizedKey, normalizedItem);
    }
  });

  const list = Array.from(classMap.values());
  list.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  return list;
}

/**
 * Extract grade digit (e.g. "Khối 5" -> "5", "5C" -> "5")
 */
export function extractGradeDigit(str?: string): string {
  if (!str) return '';
  const match = str.match(/\d+/);
  return match ? match[0] : '';
}

/**
 * Lưu một lớp học lên Cloud Firestore (`classes` collection) với auth & làm sạch dữ liệu
 */
export async function saveClassToFirestore(
  classItem: SchoolClassItem
): Promise<{ success: boolean; error?: string; code?: string }> {
  try {
    if (!db) {
      return { success: false, error: 'Chưa khởi tạo kết nối Cloud Firestore.', code: 'firestore/not-initialized' };
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
      return { success: false, error: authStatus.errorMessage || 'Chưa xác thực Firebase Auth.', code: authStatus.errorCode };
    }

    const classKey = normalizeClassKeyStrict(classItem.name || classItem.id);
    if (!classKey || isExcludedClassKey(classKey)) {
      return { success: false, error: 'Mã lớp không hợp lệ hoặc không thuộc Khối 5.', code: 'invalid-argument' };
    }

    const docId = sanitizeFirestoreDocId(classKey, 'class_5c');
    const stdName = formatClassName(classKey);
    const payload = sanitizeForFirestore({
      id: classKey,
      name: stdName,
      grade: 'Khối 5',
      room: classItem.room || '',
      homeroomTeacher: classItem.homeroomTeacher || '',
      subjects: Array.isArray(classItem.subjects) && classItem.subjects.length > 0
        ? classItem.subjects
        : STANDARD_GRADE_SUBJECTS['Khối 5'].map(s => ({ isVisible: true, subjectName: s })),
      updatedAt: new Date().toISOString()
    });

    await trackedSetDoc(
      doc(db, 'classes', docId),
      payload,
      { merge: true },
      { isUserInitiated: true, actionType: 'user_action' }
    );
    return { success: true };
  } catch (err: any) {
    const details = extractFirestoreErrorDetails(err);
    return { success: false, error: details.message, code: details.code };
  }
}

/**
 * Tự động đẩy danh sách lớp Khối 5 từ LocalStorage lên Firestore nếu trên cloud chưa có
 */
export async function syncLocalClassesToFirestoreIfMissing(
  localClasses?: SchoolClassItem[]
): Promise<{ success: boolean; syncedCount: number; error?: string; code?: string }> {
  try {
    if (!db) {
      return { success: false, syncedCount: 0, error: 'Chưa khởi tạo Cloud Firestore.', code: 'firestore/not-initialized' };
    }

    const authStatus = await ensureFirebaseAuthSessionWithStatus();
    if (!auth?.currentUser && authStatus.errorCode) {
      return { success: false, syncedCount: 0, error: authStatus.errorMessage || 'Lỗi xác thực Firebase Auth.', code: authStatus.errorCode };
    }

    let sourceList: SchoolClassItem[] = Array.isArray(localClasses) ? localClasses : [];
    if (sourceList.length === 0 && typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('eduplay_k5_classes_config');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) sourceList = parsed;
        }
      } catch {}
    }
    const dedupedLocal = deduplicateClassItems(sourceList.length > 0 ? sourceList : REAL_SCHOOL_CLASSES_FALLBACK);
    if (dedupedLocal.length === 0) {
      return { success: true, syncedCount: 0 };
    }

    const cloudSnap = await getDocs(collection(db, 'classes'));
    const existingKeys = new Set<string>();
    cloudSnap.forEach((d) => {
      const data = d.data();
      const k = normalizeClassKeyStrict(data?.name || data?.className || d.id);
      if (k) existingKeys.add(k);
    });

    let syncedCount = 0;
    for (const cls of dedupedLocal) {
      const key = normalizeClassKeyStrict(cls.name || cls.id);
      if (!key || existingKeys.has(key)) continue;
      const res = await saveClassToFirestore(cls);
      if (!res.success) {
        return { success: false, syncedCount, error: res.error, code: res.code };
      }
      syncedCount++;
    }

    return { success: true, syncedCount };
  } catch (err: any) {
    const details = extractFirestoreErrorDetails(err);
    return { success: false, syncedCount: 0, error: details.message, code: details.code };
  }
}

/**
 * Subscribe to real-time classes from Firestore 'classes' collection
 */
export function subscribeRealtimeClasses(callback: (classes: SchoolClassItem[]) => void): () => void {
  if (!db) {
    callback(REAL_SCHOOL_CLASSES_FALLBACK);
    return () => {};
  }

  try {
    const unsub = onSnapshot(collection(db, 'classes'), (snapshot) => {
      if (!snapshot.empty) {
        const classMap = new Map<string, SchoolClassItem>();

        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          const rawId = (docSnap.id || data.id || data.classId || '').trim();
          const rawName = (data.name || data.className || rawId || '').trim();
          const normalizedKey = normalizeClassKeyStrict(rawName) || normalizeClassKeyStrict(rawId);
          if (!normalizedKey || isExcludedClassKey(normalizedKey)) return;

          const name = `Lớp ${normalizedKey}`;
          const rawGrade = (data.grade || '').trim();
          const digit = extractGradeDigit(rawGrade) || extractGradeDigit(normalizedKey);
          if (digit !== '5') return;
          const grade = 'Khối 5';

          const newItem: SchoolClassItem = {
            id: normalizedKey,
            name,
            grade,
            room: data.room || '',
            homeroomTeacher: data.homeroomTeacher || '',
            subjects: Array.isArray(data.subjects) && data.subjects.length > 0
              ? data.subjects
              : STANDARD_GRADE_SUBJECTS['Khối 5'].map(s => ({ isVisible: true, subjectName: s }))
          };

          // If item already exists, merge fields favoring non-empty ones (read-only UI merge)
          if (classMap.has(normalizedKey)) {
            const existing = classMap.get(normalizedKey)!;
            classMap.set(normalizedKey, {
              ...existing,
              name: existing.name || newItem.name,
              grade: existing.grade || newItem.grade,
              room: existing.room || newItem.room,
              homeroomTeacher: existing.homeroomTeacher || newItem.homeroomTeacher,
              subjects: (existing.subjects && existing.subjects.length > 0) ? existing.subjects : newItem.subjects
            });
          } else {
            classMap.set(normalizedKey, newItem);
          }
        });

        const list = Array.from(classMap.values());
        if (list.length > 0) {
          list.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
          callback(list);
          return;
        }
      }
      callback(REAL_SCHOOL_CLASSES_FALLBACK);
    }, (err) => {
      console.warn('Firestore classes subscription warning:', err);
      callback(REAL_SCHOOL_CLASSES_FALLBACK);
    });
    return unsub;
  } catch (err) {
    console.warn('Error subscribing to Firestore classes:', err);
    callback(REAL_SCHOOL_CLASSES_FALLBACK);
    return () => {};
  }
}

/**
 * Lấy danh sách môn học cấu hình thực tế cho một Lớp/Khối (Truy vấn từ Firestore, LocalStorage hoặc chuẩn GDPT 2018)
 */
export function getSubjectsForClassOrGrade(
  classNameOrGrade?: string,
  classesList?: SchoolClassItem[]
): string[] {
  const cleanName = (classNameOrGrade || '').trim();
  const digit = extractGradeDigit(cleanName) || '5';
  const gradeKey = `Khối ${digit}`;

  // 1. Kiểm tra cấu hình cụ thể của lớp từ danh sách classes (Firestore)
  if (classesList && classesList.length > 0) {
    // Tìm theo tên lớp chính xác trước
    let matchedClass = classesList.find(c => {
      const cNameClean = c.name.replace(/^Lớp\s+/i, '').trim().toLowerCase();
      const targetClean = cleanName.replace(/^Lớp\s+/i, '').trim().toLowerCase();
      return (
        c.id.toLowerCase() === targetClean ||
        cNameClean === targetClean ||
        c.name.toLowerCase() === cleanName.toLowerCase()
      );
    });

    // Nếu không khớp tên lớp cụ thể, tìm theo khối (grade)
    if (!matchedClass) {
      matchedClass = classesList.find(c => {
        const cDigit = extractGradeDigit(c.grade) || extractGradeDigit(c.name);
        return cDigit === digit || (c.grade || '').toLowerCase() === gradeKey.toLowerCase();
      });
    }

    if (matchedClass && Array.isArray(matchedClass.subjects) && matchedClass.subjects.length > 0) {
      const activeSubjects = matchedClass.subjects
        .filter(s => s.isVisible !== false)
        .map(s => s.subjectName.trim())
        .filter(Boolean);
      return activeSubjects;
    }
  }

  // 2. Thử lấy từ localStorage 'eduplay_k5_classes_config'
  try {
    const localConfigStr = typeof window !== 'undefined' ? localStorage.getItem('eduplay_k5_classes_config') : null;
    if (localConfigStr) {
      const localClasses = JSON.parse(localConfigStr);
      if (Array.isArray(localClasses)) {
        let matchedLocal = localClasses.find((c: any) => {
          const cNameClean = (c.name || '').replace(/^Lớp\s+/i, '').trim().toLowerCase();
          const targetClean = cleanName.replace(/^Lớp\s+/i, '').trim().toLowerCase();
          return (c.id || '').toLowerCase() === targetClean || cNameClean === targetClean;
        });

        if (!matchedLocal) {
          matchedLocal = localClasses.find((c: any) => {
            const cDigit = extractGradeDigit(c.grade) || extractGradeDigit(c.name);
            return cDigit === digit || (c.grade || '').toLowerCase() === gradeKey.toLowerCase();
          });
        }

        if (matchedLocal && Array.isArray(matchedLocal.subjects) && matchedLocal.subjects.length > 0) {
          const activeSubjects = matchedLocal.subjects
            .filter((s: any) => s.isVisible !== false)
            .map((s: any) => (s.subjectName || '').trim())
            .filter(Boolean);
          return activeSubjects;
        }
      }
    }
  } catch {}

  // 3. Chuẩn hóa theo Khối học GDPT 2018 tương ứng
  return STANDARD_GRADE_SUBJECTS[gradeKey] || STANDARD_GRADE_SUBJECTS['Khối 5'];
}

import { getSubjectColorStyles, SubjectColorStyle, SUBJECT_COLOR_MAP } from '../utils/subjectColors';
export { getSubjectColorStyles, SUBJECT_COLOR_MAP };
export type { SubjectColorStyle };

/**
 * Cung cấp metadata hiển thị (chủ đề mặc định, màu gradient, styles) cho từng môn học
 */
export function getSubjectDisplayConfig(subjectName: string) {
  const styles = getSubjectColorStyles(subjectName);
  return {
    name: styles.name,
    defaultTopic: styles.defaultTopic,
    gradient: styles.gradient,
    styles
  };
}

/**
 * Custom React Hook: SINGLE SOURCE OF TRUTH for class list
 */
export function useClassesList() {
  const [classes, setClasses] = useState<SchoolClassItem[]>(() => {
    try {
      if (typeof window !== 'undefined') {
        const cached = localStorage.getItem('eduplay_k5_classes_config');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const deduped = deduplicateClassItems(parsed);
            if (deduped.length > 0) return deduped;
          }
        }
      }
    } catch {}
    return REAL_SCHOOL_CLASSES_FALLBACK;
  });
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const handleLocalUpdate = () => {
      try {
        const cached = localStorage.getItem('eduplay_k5_classes_config');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const deduped = deduplicateClassItems(parsed);
            if (deduped.length > 0) {
              setClasses(deduped);
            }
          }
        }
      } catch {}
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('eduplay_k5_classes_updated', handleLocalUpdate);
      window.addEventListener('storage', handleLocalUpdate);
    }

    const unsub = subscribeRealtimeClasses((fetched) => {
      setClasses(fetched);
      setLoading(false);
    });

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('eduplay_k5_classes_updated', handleLocalUpdate);
        window.removeEventListener('storage', handleLocalUpdate);
      }
      unsub();
    };
  }, []);

  /**
   * Filter class list by a specific grade (e.g. "Khối 5", "5", "Lớp 5")
   * If grade is null/undefined/empty or "Tất cả các khối", returns all classes.
   */
  const getClassesForGrade = useMemo(() => {
    return (gradeFilter?: string): SchoolClassItem[] => {
      if (!gradeFilter || gradeFilter === 'Tất cả' || gradeFilter === 'Tất cả các khối' || gradeFilter === 'Tất cả Lớp') {
        return classes;
      }

      const targetDigit = extractGradeDigit(gradeFilter);
      if (!targetDigit) return [];

      const filtered = classes.filter(c => {
        const classDigit = extractGradeDigit(c.grade) || extractGradeDigit(c.name);
        return classDigit === targetDigit;
      });

      return filtered;
    };
  }, [classes]);

  return {
    classes,
    loading,
    getClassesForGrade
  };
}
