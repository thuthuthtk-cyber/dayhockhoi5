import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { StudentRecord } from '../types';
import { db, auth, ensureFirebaseAuthSession, ensureFirebaseAuthSessionWithStatus } from './firebase';
import { signInAnonymously } from 'firebase/auth';
import { trackedSetDoc, trackedDeleteDoc, trackedWriteBatch, extractFirestoreErrorDetails } from './firestoreWriteTracker';
import {
  normalizeStudentCode,
  normalizeStudentName,
  preserveRawStudentCode,
  parseStudentCode,
  getStudentCodeLookupVariants
} from './studentCode';
import { normalizeClassKeyStrict, getClassKeyLookupVariants, formatClassName } from './classStorageService';
import { sanitizeForFirestore, sanitizeFirestoreDocId } from '../utils/firestoreSanitizer';
import { clearMemoryTrackingData, clearIndexedDBTrackingData } from './assignmentTrackingData';

const EDUPLAY_STUDENTS_DB_KEY = 'eduplay_k5_students_database';
const TRACKING_IDB_NAME = 'eduplay_k5_assignment_tracking_cache_db';
const TRACKING_IDB_STORE = 'tracking_cache';

export function extractCodeSuffixNumber(student: Partial<StudentRecord> | any): number | null {
  if (!student || typeof student !== 'object') return null;
  const rawCode = preserveRawStudentCode(student.studentCode || student.code || student.username || '');
  if (rawCode) {
    const parsed = parseStudentCode(rawCode);
    if (parsed && !isNaN(parsed.stt) && parsed.stt > 0) {
      return parsed.stt;
    }
    const m = rawCode.match(/(\d+)(?!.*\d)/);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  if (typeof student.stt === 'number' && !isNaN(student.stt) && student.stt > 0) {
    return student.stt;
  }
  return null;
}

export function isOld1xxStudentCode(student: Partial<StudentRecord> | any): boolean {
  const num = extractCodeSuffixNumber(student);
  return num !== null && num >= 100;
}

export function isNewUnder100StudentCode(student: Partial<StudentRecord> | any): boolean {
  const num = extractCodeSuffixNumber(student);
  return num !== null && num > 0 && num < 100;
}

export function isUpperCaseStudentName(name?: string): boolean {
  const s = (name || '').trim();
  if (!s) return false;
  return s === s.toUpperCase() && s !== s.toLowerCase();
}

export function scoreStudentRecordPriority(st: Partial<StudentRecord> | any): number {
  let score = 0;
  const num = extractCodeSuffixNumber(st);
  if (num !== null && num > 0 && num < 100) {
    score += 100000;
  } else if (num !== null && num >= 100) {
    score -= 100000;
  }

  const rawName = (st?.fullName || st?.name || '').trim();
  if (isUpperCaseStudentName(rawName)) {
    score += 10000;
  }

  const code = preserveRawStudentCode(st?.studentCode || st?.code || '');
  if (/^[A-Z0-9]+\d{2}-\d{2}-\d+$/.test(code)) {
    score += 500;
  }
  if (st?.sddcn && String(st.sddcn).trim()) score += 100;
  if (st?.phone && String(st.phone).trim()) score += 50;
  if (st?.dob && String(st.dob).trim()) score += 20;
  if (st?.parentName && String(st.parentName).trim()) score += 10;
  return score;
}

export function pickPreferredStudentRecord(a: StudentRecord, b: StudentRecord): StudentRecord {
  const scoreA = scoreStudentRecordPriority(a);
  const scoreB = scoreStudentRecordPriority(b);
  if (scoreB > scoreA) return b;
  if (scoreA > scoreB) return a;
  const tsA = Date.parse(String((a as any)?.updatedAt || '')) || 0;
  const tsB = Date.parse(String((b as any)?.updatedAt || '')) || 0;
  return tsB > tsA ? b : a;
}

export function sanitizePublicStudentRecord(st: StudentRecord, classKey: string, stdName: string) {
  const code = preserveRawStudentCode(st.studentCode || st.code || st.username || '');
  const stt = extractCodeSuffixNumber(st) || st.stt || 0;
  return sanitizeForFirestore({
    id: st.id || `st-${classKey.toLowerCase()}-${stt || 1}`,
    stt,
    code,
    studentCode: code,
    username: preserveRawStudentCode(st.username || code),
    name: (st.name || st.fullName || '').trim(),
    fullName: (st.fullName || st.name || '').trim(),
    gender: st.gender || 'Nam',
    className: stdName,
    classKey,
    avatar: st.avatar || '🌟',
    pin: st.pin || st.password || '123456',
    status: st.status || 'active',
    updatedAt: new Date().toISOString()
  });
}

export interface StoreLocationStats {
  storeId:
    | 'public_rosters'
    | 'students'
    | 'class_rosters_canonical'
    | 'class_rosters_lower'
    | 'class_rosters_other'
    | 'localStorage'
    | 'IndexedDB';
  label: string;
  totalCount: number;
  old1xxCount: number;
  newUnder100Count: number;
  otherCount: number;
  keysOrDocs: string[];
  note: string;
  readError?: string;
}

export interface KeptStudentPreviewItem {
  stt: number;
  code: string;
  normalizedCode: string;
  name: string;
  normalizedName: string;
  locations: string[];
}

export interface OldDuplicatePreviewItem {
  previewId: string;
  code: string;
  normalizedCode: string;
  name: string;
  normalizedName: string;
  stt: number | null;
  matchedKeepCode: string | null;
  matchedKeepName: string | null;
  locations: string[];
  reason: string;
  studentDocIdsToDelete: string[];
  publicDocIdsToDelete: string[];
}

export interface VariantDocCleanupTarget {
  collection: 'class_rosters' | 'public_rosters';
  docId: string;
  rawCount: number;
  old1xxCount: number;
  newUnder100Count: number;
}

export interface ClassStudentDuplicateAuditReport {
  classKey: string;
  className: string;
  scannedAt: string;
  stores: StoreLocationStats[];
  recordsToKeep: KeptStudentPreviewItem[];
  recordsToDelete: OldDuplicatePreviewItem[];
  variantRosterDocsToClean: VariantDocCleanupTarget[];
  whyUiDeleteFailedReasons: string[];
  indexedDbDetails: {
    dbNames: string[];
    trackingCacheEntriesForClass: number;
    firestorePersistenceDetected: boolean;
  };
  rawCanonicalKeepStudents: StudentRecord[];
}

export interface SynchronizedCleanupResult {
  success: boolean;
  deletedOldCount: number;
  keptCount: number;
  deletedStudentDocsCount: number;
  cleanedVariantDocsCount: number;
  errors: string[];
  warnings: string[];
  backupStorageKey: string | null;
  beforeReport: ClassStudentDuplicateAuditReport;
  afterReport: ClassStudentDuplicateAuditReport;
}

function recordBelongsToClass(st: any, docId: string, classKey: string): boolean {
  const rawCls = st?.classKey || st?.className || st?.class || st?.classId || st?.lop || '';
  if (rawCls && normalizeClassKeyStrict(String(rawCls)) === classKey) {
    return true;
  }
  const rawCode = preserveRawStudentCode(st?.studentCode || st?.code || st?.username || docId || '');
  const codeMatch = rawCode.match(/^([A-Z0-9]+)\d{2}-\d{2}-\d+$/);
  if (codeMatch && codeMatch[1] === classKey) {
    return true;
  }
  if (!rawCls && docId && normalizeClassKeyStrict(docId) === classKey) {
    return true;
  }
  return false;
}

function extractRosterArrayFromDoc(data: any): StudentRecord[] {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.students)) return data.students;
  if (Array.isArray(data.studentList)) return data.studentList;
  if (Array.isArray(data.roster)) return data.roster;
  return [];
}

function countByCodeRange(records: Array<Partial<StudentRecord> | any>) {
  let old1xxCount = 0;
  let newUnder100Count = 0;
  let otherCount = 0;
  records.forEach((r) => {
    const num = extractCodeSuffixNumber(r);
    if (num !== null && num >= 100) old1xxCount++;
    else if (num !== null && num > 0 && num < 100) newUnder100Count++;
    else otherCount++;
  });
  return {
    totalCount: records.length,
    old1xxCount,
    newUnder100Count,
    otherCount
  };
}

async function readTrackingIndexedDbRowsForClass(classKey: string): Promise<{
  dbNames: string[];
  trackingCacheEntriesForClass: number;
  rows: Array<{ assignmentId: string; student: Partial<StudentRecord> }>;
  firestorePersistenceDetected: boolean;
}> {
  let dbNames: string[] = [];
  let firestorePersistenceDetected = false;
  if (typeof window === 'undefined' || !window.indexedDB) {
    return { dbNames, trackingCacheEntriesForClass: 0, rows: [], firestorePersistenceDetected };
  }

  try {
    if (typeof (window.indexedDB as any).databases === 'function') {
      const dbs = await (window.indexedDB as any).databases();
      if (Array.isArray(dbs)) {
        dbNames = dbs.map((d: any) => String(d?.name || '')).filter(Boolean);
        firestorePersistenceDetected = dbNames.some((n) => n.toLowerCase().includes('firestore'));
      }
    }
  } catch {}

  const rows: Array<{ assignmentId: string; student: Partial<StudentRecord> }> = [];
  let trackingCacheEntriesForClass = 0;

  // Read existing tracking cache DB only if present (do not pollute if absent)
  const shouldOpenTracking = dbNames.length === 0 || dbNames.includes(TRACKING_IDB_NAME);
  if (shouldOpenTracking) {
    try {
      const idb = await new Promise<IDBDatabase | null>((resolve) => {
        try {
          const req = window.indexedDB.open(TRACKING_IDB_NAME, 1);
          req.onupgradeneeded = (ev: any) => {
            const inst = ev.target.result as IDBDatabase;
            if (!inst.objectStoreNames.contains(TRACKING_IDB_STORE)) {
              inst.createObjectStore(TRACKING_IDB_STORE, { keyPath: 'assignmentId' });
            }
          };
          req.onsuccess = (ev: any) => resolve(ev.target.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });

      if (idb) {
        await new Promise<void>((resolve) => {
          try {
            if (!idb.objectStoreNames.contains(TRACKING_IDB_STORE)) {
              idb.close();
              resolve();
              return;
            }
            const tx = idb.transaction(TRACKING_IDB_STORE, 'readonly');
            const store = tx.objectStore(TRACKING_IDB_STORE);
            const req = store.getAll();
            req.onsuccess = () => {
              const allEntries = Array.isArray(req.result) ? req.result : [];
              allEntries.forEach((entry: any) => {
                const entryClassKey = normalizeClassKeyStrict(entry?.targetClass || '');
                const list = Array.isArray(entry?.trackingList) ? entry.trackingList : [];
                const matchingRows = list.filter((row: any) => {
                  if (entryClassKey === classKey) return true;
                  return recordBelongsToClass(row, '', classKey);
                });
                if (matchingRows.length > 0) {
                  trackingCacheEntriesForClass++;
                  matchingRows.forEach((row: any) => {
                    rows.push({
                      assignmentId: String(entry?.assignmentId || 'unknown'),
                      student: {
                        code: row?.code,
                        studentCode: row?.code,
                        name: row?.name,
                        fullName: row?.name,
                        stt: row?.stt
                      }
                    });
                  });
                }
              });
              idb.close();
              resolve();
            };
            req.onerror = () => {
              idb.close();
              resolve();
            };
          } catch {
            try { idb.close(); } catch {}
            resolve();
          }
        });
      }
    } catch {}
  }

  return {
    dbNames,
    trackingCacheEntriesForClass,
    rows,
    firestorePersistenceDetected
  };
}

/**
 * BƯỚC 1 & 2 (TUYỆT ĐỐI CHỈ ĐỌC — KHÔNG GHI/KHÔNG XÓA BẤT KỲ DỮ LIỆU NÀO):
 * Kiểm tra toàn bộ bản ghi học sinh của lớp tại tất cả nơi lưu:
 * public_rosters, students, class_rosters/{KEY}, class_rosters/{key_lower}, localStorage, IndexedDB.
 */
export async function inspectClassStudentDuplicatesAcrossStores(
  classNameOrKey: string
): Promise<ClassStudentDuplicateAuditReport> {
  const classKey = normalizeClassKeyStrict(classNameOrKey);
  const stdName = formatClassName(classKey) || `Lớp ${classKey}`;
  const lowerKey = classKey.toLowerCase();

  type ScannedOccurrence = {
    storeLabel: string;
    storeCategory: 'public_rosters' | 'students' | 'class_rosters' | 'localStorage' | 'IndexedDB';
    docId?: string;
    lsKey?: string;
    student: StudentRecord;
  };

  const allOccurrences: ScannedOccurrence[] = [];
  const variantRosterDocsToClean: VariantDocCleanupTarget[] = [];

  // Raw per-store arrays
  const publicRecords: StudentRecord[] = [];
  const publicDocKeys: string[] = [];
  let publicError: string | undefined;

  const studentColRecords: StudentRecord[] = [];
  const studentColDocIds: string[] = [];
  let studentsColError: string | undefined;

  const rosterCanonicalRecords: StudentRecord[] = [];
  const rosterCanonicalDocs: string[] = [];
  const rosterLowerRecords: StudentRecord[] = [];
  const rosterLowerDocs: string[] = [];
  const rosterOtherRecords: StudentRecord[] = [];
  const rosterOtherDocs: string[] = [];
  let rostersError: string | undefined;

  const lsUnionRecords: StudentRecord[] = [];
  const lsKeysFound: string[] = [];
  const lsPerKeyNotes: string[] = [];

  if (db) {
    try {
      await ensureFirebaseAuthSession();
    } catch {}

    // 1. Inspect `public_rosters`
    try {
      const pubSnap = await getDocs(collection(db, 'public_rosters'));
      pubSnap.forEach((docSnap) => {
        const data = docSnap.data() as any;
        const arr = extractRosterArrayFromDoc(data);
        if (arr.length > 0) {
          const docClassKey = normalizeClassKeyStrict(data?.classKey || data?.className || docSnap.id) || normalizeClassKeyStrict(docSnap.id);
          if (docClassKey !== classKey) return;
          publicDocKeys.push(`public_rosters/${docSnap.id}`);
          arr.forEach((st) => {
            if (!st || typeof st !== 'object') return;
            publicRecords.push(st);
            allOccurrences.push({
              storeLabel: `public_rosters/${docSnap.id}`,
              storeCategory: 'public_rosters',
              docId: docSnap.id,
              student: st
            });
          });
          if (docSnap.id !== classKey) {
            const counts = countByCodeRange(arr);
            variantRosterDocsToClean.push({
              collection: 'public_rosters',
              docId: docSnap.id,
              rawCount: counts.totalCount,
              old1xxCount: counts.old1xxCount,
              newUnder100Count: counts.newUnder100Count
            });
          }
        } else if (recordBelongsToClass(data, docSnap.id, classKey)) {
          const st = { ...(data as StudentRecord), id: data?.id || docSnap.id };
          publicDocKeys.push(`public_rosters/${docSnap.id}`);
          publicRecords.push(st);
          allOccurrences.push({
            storeLabel: `public_rosters/${docSnap.id}`,
            storeCategory: 'public_rosters',
            docId: docSnap.id,
            student: st
          });
        }
      });
    } catch (err: any) {
      const details = extractFirestoreErrorDetails(err);
      publicError = details.message;
      // Fallback getDoc by class key variants
      const variants = getClassKeyLookupVariants(classKey);
      for (const vid of variants) {
        try {
          const snap = await getDoc(doc(db, 'public_rosters', vid));
          if (snap.exists()) {
            const data = snap.data() as any;
            const arr = extractRosterArrayFromDoc(data);
            publicDocKeys.push(`public_rosters/${snap.id}`);
            arr.forEach((st) => {
              publicRecords.push(st);
              allOccurrences.push({
                storeLabel: `public_rosters/${snap.id}`,
                storeCategory: 'public_rosters',
                docId: snap.id,
                student: st
              });
            });
            if (snap.id !== classKey) {
              const counts = countByCodeRange(arr);
              variantRosterDocsToClean.push({
                collection: 'public_rosters',
                docId: snap.id,
                rawCount: counts.totalCount,
                old1xxCount: counts.old1xxCount,
                newUnder100Count: counts.newUnder100Count
              });
            }
          }
        } catch {}
      }
      if (publicRecords.length > 0) publicError = undefined;
    }

    // 2. Inspect `students` collection
    try {
      const sSnap = await getDocs(collection(db, 'students'));
      sSnap.forEach((docSnap) => {
        const data = docSnap.data() as any;
        if (!recordBelongsToClass(data, docSnap.id, classKey)) return;
        const st: StudentRecord = { ...(data as StudentRecord), id: data?.id || docSnap.id };
        studentColDocIds.push(docSnap.id);
        studentColRecords.push(st);
        allOccurrences.push({
          storeLabel: `students/${docSnap.id}`,
          storeCategory: 'students',
          docId: docSnap.id,
          student: st
        });
      });
    } catch (err: any) {
      const details = extractFirestoreErrorDetails(err);
      studentsColError = details.message;
      try {
        const seenIds = new Set<string>();
        const variants = getClassKeyLookupVariants(classKey).slice(0, 10);
        const q1 = await getDocs(query(collection(db, 'students'), where('classKey', '==', classKey)));
        q1.forEach((docSnap) => {
          if (seenIds.has(docSnap.id)) return;
          seenIds.add(docSnap.id);
          const data = docSnap.data() as any;
          const st: StudentRecord = { ...(data as StudentRecord), id: data?.id || docSnap.id };
          studentColDocIds.push(docSnap.id);
          studentColRecords.push(st);
          allOccurrences.push({
            storeLabel: `students/${docSnap.id}`,
            storeCategory: 'students',
            docId: docSnap.id,
            student: st
          });
        });
        if (variants.length > 0) {
          const q2 = await getDocs(query(collection(db, 'students'), where('className', 'in', variants)));
          q2.forEach((docSnap) => {
            if (seenIds.has(docSnap.id)) return;
            seenIds.add(docSnap.id);
            const data = docSnap.data() as any;
            const st: StudentRecord = { ...(data as StudentRecord), id: data?.id || docSnap.id };
            studentColDocIds.push(docSnap.id);
            studentColRecords.push(st);
            allOccurrences.push({
              storeLabel: `students/${docSnap.id}`,
              storeCategory: 'students',
              docId: docSnap.id,
              student: st
            });
          });
        }
        if (studentColRecords.length > 0) studentsColError = undefined;
      } catch {}
    }

    // 3. Inspect `class_rosters` (canonical `5D`, lowercase `5d`, and any other variants)
    try {
      const rSnap = await getDocs(collection(db, 'class_rosters'));
      rSnap.forEach((docSnap) => {
        const data = docSnap.data() as any;
        const docClassKey = normalizeClassKeyStrict(data?.classKey || data?.className || docSnap.id) || normalizeClassKeyStrict(docSnap.id);
        if (docClassKey !== classKey) return;
        const arr = extractRosterArrayFromDoc(data);

        if (docSnap.id === classKey) {
          rosterCanonicalDocs.push(`class_rosters/${docSnap.id}`);
          arr.forEach((st) => {
            if (!st || typeof st !== 'object') return;
            rosterCanonicalRecords.push(st);
            allOccurrences.push({
              storeLabel: `class_rosters/${docSnap.id}`,
              storeCategory: 'class_rosters',
              docId: docSnap.id,
              student: st
            });
          });
        } else if (docSnap.id === lowerKey) {
          rosterLowerDocs.push(`class_rosters/${docSnap.id}`);
          arr.forEach((st) => {
            if (!st || typeof st !== 'object') return;
            rosterLowerRecords.push(st);
            allOccurrences.push({
              storeLabel: `class_rosters/${docSnap.id}`,
              storeCategory: 'class_rosters',
              docId: docSnap.id,
              student: st
            });
          });
          const counts = countByCodeRange(arr);
          variantRosterDocsToClean.push({
            collection: 'class_rosters',
            docId: docSnap.id,
            rawCount: counts.totalCount,
            old1xxCount: counts.old1xxCount,
            newUnder100Count: counts.newUnder100Count
          });
        } else {
          rosterOtherDocs.push(`class_rosters/${docSnap.id}`);
          arr.forEach((st) => {
            if (!st || typeof st !== 'object') return;
            rosterOtherRecords.push(st);
            allOccurrences.push({
              storeLabel: `class_rosters/${docSnap.id}`,
              storeCategory: 'class_rosters',
              docId: docSnap.id,
              student: st
            });
          });
          const counts = countByCodeRange(arr);
          variantRosterDocsToClean.push({
            collection: 'class_rosters',
            docId: docSnap.id,
            rawCount: counts.totalCount,
            old1xxCount: counts.old1xxCount,
            newUnder100Count: counts.newUnder100Count
          });
        }
      });
    } catch (err: any) {
      const details = extractFirestoreErrorDetails(err);
      rostersError = details.message;
      const variants = getClassKeyLookupVariants(classKey);
      for (const vid of variants) {
        try {
          const docSnap = await getDoc(doc(db, 'class_rosters', vid));
          if (!docSnap.exists()) continue;
          const data = docSnap.data() as any;
          const arr = extractRosterArrayFromDoc(data);
          if (docSnap.id === classKey) {
            rosterCanonicalDocs.push(`class_rosters/${docSnap.id}`);
            arr.forEach((st) => {
              rosterCanonicalRecords.push(st);
              allOccurrences.push({
                storeLabel: `class_rosters/${docSnap.id}`,
                storeCategory: 'class_rosters',
                docId: docSnap.id,
                student: st
              });
            });
          } else if (docSnap.id === lowerKey) {
            rosterLowerDocs.push(`class_rosters/${docSnap.id}`);
            arr.forEach((st) => {
              rosterLowerRecords.push(st);
              allOccurrences.push({
                storeLabel: `class_rosters/${docSnap.id}`,
                storeCategory: 'class_rosters',
                docId: docSnap.id,
                student: st
              });
            });
          } else {
            rosterOtherDocs.push(`class_rosters/${docSnap.id}`);
            arr.forEach((st) => {
              rosterOtherRecords.push(st);
              allOccurrences.push({
                storeLabel: `class_rosters/${docSnap.id}`,
                storeCategory: 'class_rosters',
                docId: docSnap.id,
                student: st
              });
            });
          }
        } catch {}
      }
      if (rosterCanonicalDocs.length > 0 || rosterLowerDocs.length > 0 || rosterOtherDocs.length > 0) {
        rostersError = undefined;
      }
    }
  }

  // 4. Inspect `localStorage` (read-only across ALL variant keys & master DB)
  const lsSeenCodeOrName = new Set<string>();
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('eduplay_k5_students_') || key === EDUPLAY_STUDENTS_DB_KEY) continue;
        const suffix = key.replace('eduplay_k5_students_', '');
        if (normalizeClassKeyStrict(suffix) !== classKey) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            lsKeysFound.push(key);
            lsPerKeyNotes.push(`${key} (${parsed.length})`);
            parsed.forEach((st) => {
              if (!st || typeof st !== 'object') return;
              allOccurrences.push({
                storeLabel: `localStorage:${key}`,
                storeCategory: 'localStorage',
                lsKey: key,
                student: st
              });
              const k = normalizeStudentCode(st.studentCode || st.code) || normalizeStudentName(st.fullName || st.name) || st.id;
              if (k && !lsSeenCodeOrName.has(k)) {
                lsSeenCodeOrName.add(k);
                lsUnionRecords.push(st);
              }
            });
          }
        } catch {}
      }

      const masterRaw = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
      if (masterRaw) {
        try {
          const masterParsed = JSON.parse(masterRaw);
          if (masterParsed && typeof masterParsed === 'object') {
            Object.entries(masterParsed).forEach(([rawDbKey, listVal]) => {
              if (normalizeClassKeyStrict(rawDbKey) !== classKey || !Array.isArray(listVal)) return;
              const label = `${EDUPLAY_STUDENTS_DB_KEY}["${rawDbKey}"]`;
              lsKeysFound.push(label);
              lsPerKeyNotes.push(`${rawDbKey} trong masterDB (${listVal.length})`);
              listVal.forEach((st: any) => {
                if (!st || typeof st !== 'object') return;
                allOccurrences.push({
                  storeLabel: `localStorage:${label}`,
                  storeCategory: 'localStorage',
                  lsKey: label,
                  student: st
                });
                const k = normalizeStudentCode(st.studentCode || st.code) || normalizeStudentName(st.fullName || st.name) || st.id;
                if (k && !lsSeenCodeOrName.has(k)) {
                  lsSeenCodeOrName.add(k);
                  lsUnionRecords.push(st);
                }
              });
            });
          }
        } catch {}
      }
    } catch {}
  }

  // 5. Inspect `IndexedDB` (read-only)
  const idbResult = await readTrackingIndexedDbRowsForClass(classKey);
  const idbUniqueStudentsMap = new Map<string, Partial<StudentRecord>>();
  idbResult.rows.forEach(({ assignmentId, student }) => {
    const code = normalizeStudentCode(student.studentCode || student.code);
    const normName = normalizeStudentName(student.fullName || student.name);
    const dedupKey = code || normName;
    if (dedupKey && !idbUniqueStudentsMap.has(dedupKey)) {
      idbUniqueStudentsMap.set(dedupKey, student);
    }
    allOccurrences.push({
      storeLabel: `IndexedDB:${TRACKING_IDB_NAME} (${assignmentId})`,
      storeCategory: 'IndexedDB',
      student: student as StudentRecord
    });
  });
  const idbStudentsList = Array.from(idbUniqueStudentsMap.values());

  // Build per-store counts
  const pubCounts = countByCodeRange(publicRecords);
  const studColCounts = countByCodeRange(studentColRecords);
  const canonRosterCounts = countByCodeRange(rosterCanonicalRecords);
  const lowerRosterCounts = countByCodeRange(rosterLowerRecords);
  const otherRosterCounts = countByCodeRange(rosterOtherRecords);
  const lsCounts = countByCodeRange(lsUnionRecords);
  const idbCounts = countByCodeRange(idbStudentsList);

  const stores: StoreLocationStats[] = [
    {
      storeId: 'public_rosters',
      label: 'public_rosters',
      ...pubCounts,
      keysOrDocs: publicDocKeys,
      note: publicError
        ? `Không đọc được (${publicError})`
        : publicDocKeys.length > 0
        ? `Tài liệu: ${publicDocKeys.join(', ')}`
        : 'Chưa có tài liệu nào cho lớp này',
      readError: publicError
    },
    {
      storeId: 'students',
      label: 'students',
      ...studColCounts,
      keysOrDocs: studentColDocIds.map((id) => `students/${id}`),
      note: studentsColError
        ? `Không đọc được (${studentsColError})`
        : studentColDocIds.length > 0
        ? `${studentColDocIds.length} document riêng lẻ thuộc lớp ${classKey}`
        : 'Không có document nào trong collection students',
      readError: studentsColError
    },
    {
      storeId: 'class_rosters_canonical',
      label: `class_rosters/${classKey}`,
      ...canonRosterCounts,
      keysOrDocs: rosterCanonicalDocs,
      note: rostersError
        ? `Không đọc được (${rostersError})`
        : rosterCanonicalDocs.length > 0
        ? 'Tài liệu khóa chuẩn chính thức'
        : `Chưa tồn tại document class_rosters/${classKey}`,
      readError: rostersError
    },
    {
      storeId: 'class_rosters_lower',
      label: `class_rosters/${lowerKey}`,
      ...lowerRosterCounts,
      keysOrDocs: rosterLowerDocs,
      note:
        rosterLowerDocs.length > 0
          ? 'Tài liệu khóa chữ thường biến thể (gây ghi đè / lặp danh sách)'
          : `Không có document class_rosters/${lowerKey}`
    }
  ];

  if (rosterOtherDocs.length > 0) {
    stores.push({
      storeId: 'class_rosters_other',
      label: 'class_rosters (biến thể khác)',
      ...otherRosterCounts,
      keysOrDocs: rosterOtherDocs,
      note: `Tài liệu biến thể khác: ${rosterOtherDocs.join(', ')}`
    });
  }

  stores.push(
    {
      storeId: 'localStorage',
      label: 'localStorage',
      ...lsCounts,
      keysOrDocs: lsKeysFound,
      note: lsPerKeyNotes.length > 0 ? `Khóa: ${lsPerKeyNotes.join(' | ')}` : 'Không có dữ liệu lớp trong localStorage'
    },
    {
      storeId: 'IndexedDB',
      label: 'IndexedDB',
      ...idbCounts,
      keysOrDocs: idbResult.dbNames,
      note:
        idbStudentsList.length > 0
          ? `${idbResult.trackingCacheEntriesForClass} bảng cache tracking (${TRACKING_IDB_NAME})` +
            (idbResult.firestorePersistenceDetected ? ' + Firestore persistentLocalCache' : '')
          : idbResult.firestorePersistenceDetected
          ? `0 HS trong tracking_cache; có Firestore persistentLocalCache (${idbResult.dbNames.filter((n) => n.toLowerCase().includes('firestore')).length} DB SDK)`
          : 'Không có bản ghi cache học sinh trong IndexedDB'
    }
  );

  // =========================================================================
  // Determine which records to KEEP (< 100 / highest priority per normalized name & code)
  // and which records to DELETE (1xx old codes & redundant duplicate names)
  // =========================================================================
  // First collect all candidate records grouped by normalized code
  type CodeBucket = {
    normCode: string;
    rawCode: string;
    bestStudent: StudentRecord;
    locations: Set<string>;
    studentDocIds: Set<string>;
    publicDocIds: Set<string>;
  };

  const byNormCode = new Map<string, CodeBucket>();

  allOccurrences.forEach((occ) => {
    const st = occ.student;
    const rawName = (st.fullName || st.name || '').trim();
    if (!rawName) return;
    const rawCode = preserveRawStudentCode(st.studentCode || st.code || st.username || '');
    const normCode = normalizeStudentCode(rawCode);
    const normName = normalizeStudentName(rawName);
    const bucketKey = normCode || `NONAME:${normName}`;

    let bucket = byNormCode.get(bucketKey);
    if (!bucket) {
      bucket = {
        normCode,
        rawCode: rawCode || normCode,
        bestStudent: st,
        locations: new Set<string>(),
        studentDocIds: new Set<string>(),
        publicDocIds: new Set<string>()
      };
      byNormCode.set(bucketKey, bucket);
    } else {
      bucket.bestStudent = pickPreferredStudentRecord(bucket.bestStudent, st);
    }
    bucket.locations.add(occ.storeLabel);
    if (occ.storeCategory === 'students' && occ.docId) {
      bucket.studentDocIds.add(occ.docId);
    }
    if (occ.storeCategory === 'public_rosters' && occ.docId && occ.docId !== classKey && !['class_rosters', 'public_rosters'].some((c) => occ.docId === c)) {
      // Track individual public_rosters doc if docId looks like a student doc rather than class doc
      if (normalizeClassKeyStrict(occ.docId) !== classKey) {
        bucket.publicDocIds.add(occ.docId);
      }
    }
  });

  // Group buckets by normalizedName to detect old vs new for the same student
  const byNormName = new Map<string, CodeBucket[]>();
  byNormCode.forEach((bucket) => {
    const normName = normalizeStudentName(bucket.bestStudent.fullName || bucket.bestStudent.name);
    const nameKey = normName || `__CODE__${bucket.normCode}`;
    const list = byNormName.get(nameKey) || [];
    list.push(bucket);
    byNormName.set(nameKey, list);
  });

  const hasAnyUnder100InClass = Array.from(byNormCode.values()).some((b) => isNewUnder100StudentCode(b.bestStudent));

  const keptBuckets: CodeBucket[] = [];
  const deleteBuckets: Array<{
    bucket: CodeBucket;
    matchedKeep: CodeBucket | null;
    reason: string;
  }> = [];

  byNormName.forEach((bucketsForName) => {
    // Sort best-first (prefers <100, then UPPERCASE, then richer metadata)
    const sorted = [...bucketsForName].sort((a, b) => {
      const winner = pickPreferredStudentRecord(a.bestStudent, b.bestStudent);
      return winner === a.bestStudent ? -1 : 1;
    });

    const best = sorted[0];
    const bestIsOld1xx = isOld1xxStudentCode(best.bestStudent);

    // If the ONLY record(s) for this name are 1xx while the class already has a new < 100 roster,
    // check whether this 1xx is an orphan old record vs kept.
    if (bestIsOld1xx && hasAnyUnder100InClass) {
      sorted.forEach((b) => {
        deleteBuckets.push({
          bucket: b,
          matchedKeep: null,
          reason: 'Bản cũ mã 1xx (>= 100), lớp đã có danh sách mới < 100'
        });
      });
      return;
    }

    // Keep the top winner (< 100 or best valid record)
    keptBuckets.push(best);

    // Every remaining bucket sharing the exact same normalized name is a duplicate/old record to delete!
    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i];
      const loserIs1xx = isOld1xxStudentCode(loser.bestStudent);
      deleteBuckets.push({
        bucket: loser,
        matchedKeep: best,
        reason: loserIs1xx
          ? `Bản cũ mã 1xx (trùng tên với ${best.rawCode})`
          : `Bản trùng tên chuẩn hóa với ${best.rawCode}`
      });
    }
  });

  // Sort kept list cleanly by STT / Vietnamese name order without renumbering codes
  const rawCanonicalKeepStudents: StudentRecord[] = keptBuckets
    .map((b) => {
      const st = b.bestStudent;
      const stt = extractCodeSuffixNumber(st) || st.stt || 0;
      const rawCode = preserveRawStudentCode(st.studentCode || st.code || st.username || '');
      const cleanName = (st.name || st.fullName || '').trim();
      const cleanFullName = (st.fullName || st.name || '').trim();
      return {
        ...st,
        id: st.id && !String(st.id).startsWith('st-') ? st.id : `st-${classKey.toLowerCase()}-${stt || 1}`,
        stt,
        code: rawCode,
        studentCode: rawCode,
        username: preserveRawStudentCode(st.username || rawCode),
        name: cleanName,
        fullName: cleanFullName,
        className: stdName,
        pin: st.pin || st.password || '123456',
        password: st.password || st.pin || '123456'
      } as StudentRecord;
    })
    .sort((a, b) => (a.stt || 0) - (b.stt || 0));

  const keptCodesSet = new Set(
    rawCanonicalKeepStudents.map((s) => normalizeStudentCode(s.studentCode || s.code)).filter(Boolean)
  );

  const recordsToKeep: KeptStudentPreviewItem[] = keptBuckets
    .map((b) => ({
      stt: extractCodeSuffixNumber(b.bestStudent) || b.bestStudent.stt || 0,
      code: b.rawCode,
      normalizedCode: b.normCode,
      name: (b.bestStudent.fullName || b.bestStudent.name || '').trim(),
      normalizedName: normalizeStudentName(b.bestStudent.fullName || b.bestStudent.name),
      locations: Array.from(b.locations)
    }))
    .sort((a, b) => a.stt - b.stt);

  const recordsToDelete: OldDuplicatePreviewItem[] = deleteBuckets
    .filter((entry) => {
      // Hard safety guarantee: never mark a < 100 kept student code for deletion
      if (isNewUnder100StudentCode(entry.bucket.bestStudent) && keptCodesSet.has(entry.bucket.normCode) && !entry.matchedKeep) {
        return false;
      }
      // If somehow a duplicate had the exact same normalizedCode as kept, only delete if it's strictly a second loser copy?
      // Never put the kept code itself if its stt < 100 unless matchedKeep has a DIFFERENT code or is a strictly different record
      if (isNewUnder100StudentCode(entry.bucket.bestStudent) && entry.matchedKeep && entry.matchedKeep.normCode === entry.bucket.normCode) {
        return false;
      }
      return true;
    })
    .map((entry, idx) => {
      const b = entry.bucket;
      return {
        previewId: `${b.normCode || 'old'}-${idx}`,
        code: b.rawCode,
        normalizedCode: b.normCode,
        name: (b.bestStudent.fullName || b.bestStudent.name || '').trim(),
        normalizedName: normalizeStudentName(b.bestStudent.fullName || b.bestStudent.name),
        stt: extractCodeSuffixNumber(b.bestStudent),
        matchedKeepCode: entry.matchedKeep ? entry.matchedKeep.rawCode : null,
        matchedKeepName: entry.matchedKeep ? (entry.matchedKeep.bestStudent.fullName || entry.matchedKeep.bestStudent.name || '').trim() : null,
        locations: Array.from(b.locations),
        reason: entry.reason,
        studentDocIdsToDelete: Array.from(b.studentDocIds).filter((docId) => !keptCodesSet.has(normalizeStudentCode(docId))),
        publicDocIdsToDelete: Array.from(b.publicDocIds)
      };
    })
    .sort((a, b) => (a.stt || 999) - (b.stt || 999));

  const whyUiDeleteFailedReasons: string[] = [
    'Collection `public_rosters` chưa từng được gọi trong luồng xóa/nhập của ứng dụng nên mọi bản cũ còn nằm trong `public_rosters` không bị xóa.',
    'Hàm xóa trước đây chỉ xóa `students/{id}`, `students/{code}` và query `where("code", "==", code)` — bỏ sót tài liệu lưu bằng trường `studentCode` hoặc docId khác (vd `st-5d-146`), đồng thời listener `onSnapshot(collection(db, "students"))` gộp ngược lại toàn bộ doc còn sót về giao diện.',
    'Hàm nhập Excel chỉ gọi `batch.set(..., { merge: true })` mà không xóa doc cũ trong `students`, khiến danh sách cũ (`1xx`) và danh sách mới (`< 100`) cộng dồn thành 74 em.',
    'Collection `class_rosters` có thể tồn tại khóa biến thể (như `class_rosters/5d`, `Lớp 5D`) và listener lấy bản có mảng dài hơn (`74 > 37`), ghi đè ngược lại danh sách mới.',
    'Bộ nhớ trình duyệt (`localStorage` khóa biến thể như `eduplay_k5_students_5d`, `eduplay_k5_students_database`) và `IndexedDB` (`eduplay_k5_assignment_tracking_cache_db` + Firestore `persistentLocalCache`) chưa được dọn đồng bộ khi xóa.',
    'Hàm khử trùng trước đây chỉ kiểm tra theo `studentCode` (`5D26-27-146` khác `5D26-27-46`), chưa khử trùng theo họ tên chuẩn hóa bỏ dấu/hoa-thường.'
  ];

  return {
    classKey,
    className: stdName,
    scannedAt: new Date().toISOString(),
    stores,
    recordsToKeep,
    recordsToDelete,
    variantRosterDocsToClean,
    whyUiDeleteFailedReasons,
    indexedDbDetails: {
      dbNames: idbResult.dbNames,
      trackingCacheEntriesForClass: idbResult.trackingCacheEntriesForClass,
      firestorePersistenceDetected: idbResult.firestorePersistenceDetected
    },
    rawCanonicalKeepStudents
  };
}

/**
 * Đồng bộ collection `public_rosters/{KEY}` (và xóa doc biến thể nếu có) với danh sách lớp đã làm sạch.
 * Bọc try/catch an toàn để không làm gián đoạn luồng chính nếu Rules chưa triển khai `public_rosters`.
 */
export async function syncPublicRosterToFirestore(
  className: string,
  students: StudentRecord[]
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!db) return { success: false, error: 'Chưa khởi tạo Firestore.' };
    const classKey = normalizeClassKeyStrict(className);
    if (!classKey) return { success: false, error: 'Khóa lớp không hợp lệ.' };
    const stdName = formatClassName(classKey);
    const safeClassKey = sanitizeFirestoreDocId(classKey, classKey);
    const nowIso = new Date().toISOString();

    const publicStudents = students.map((st) => sanitizePublicStudentRecord(st, classKey, stdName));
    const male = publicStudents.filter((s) => s.gender === 'Nam').length;
    const female = publicStudents.filter((s) => s.gender === 'Nữ').length;

    await trackedSetDoc(
      doc(db, 'public_rosters', safeClassKey),
      sanitizeForFirestore({
        className: stdName,
        classKey,
        grade: 'Khối 5',
        totalStudents: publicStudents.length,
        male,
        female,
        students: publicStudents,
        updatedAt: nowIso
      }),
      undefined,
      { isUserInitiated: true, actionType: 'admin_batch' }
    );

    // Clean any variant doc IDs in public_rosters normalizing to classKey (e.g. 5d, Lớp 5D)
    const variantIds = getClassKeyLookupVariants(classKey).filter((v) => v !== safeClassKey);
    for (const vid of variantIds) {
      const safeVid = sanitizeFirestoreDocId(vid, '');
      if (!safeVid || safeVid === safeClassKey) continue;
      try {
        const vSnap = await getDoc(doc(db, 'public_rosters', safeVid));
        if (vSnap.exists()) {
          await trackedDeleteDoc(doc(db, 'public_rosters', safeVid), { isUserInitiated: true, actionType: 'admin_batch' });
        }
      } catch {}
    }

    return { success: true };
  } catch (err: any) {
    const details = extractFirestoreErrorDetails(err);
    return { success: false, error: details.message };
  }
}

/**
 * BƯỚC 3 & BƯỚC 5:
 * Chỉ thực thi KHI Admin bấm "Xác nhận xóa bản cũ".
 * Xóa ĐỒNG BỘ bản cũ ở tất cả 5 nơi: public_rosters, students, class_rosters, localStorage, IndexedDB.
 * TUYỆT ĐỐI KHÔNG xóa bản mới < 100 (5D26-27-46...) và KHÔNG xóa bài nộp / bài làm của học sinh.
 */
export async function executeConfirmedOldDuplicateCleanup(
  auditReport: ClassStudentDuplicateAuditReport
): Promise<SynchronizedCleanupResult> {
  const { classKey, className, recordsToDelete, rawCanonicalKeepStudents, variantRosterDocsToClean } = auditReport;
  const errors: string[] = [];
  const warnings: string[] = [];
  const keptStudents = [...rawCanonicalKeepStudents];
  const keptCodesSet = new Set(
    keptStudents.map((s) => normalizeStudentCode(s.studentCode || s.code)).filter(Boolean)
  );
  const oldCodesToDeleteSet = new Set(
    recordsToDelete.map((r) => normalizeStudentCode(r.normalizedCode || r.code)).filter((c) => Boolean(c) && !keptCodesSet.has(c))
  );

  // 0. Create automatic JSON backup in localStorage before making any changes
  let backupStorageKey: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      backupStorageKey = `eduplay_k5_dedup_backup_${classKey}_${Date.now()}`;
      localStorage.setItem(
        backupStorageKey,
        JSON.stringify({
          createdAt: new Date().toISOString(),
          classKey,
          className,
          keptCount: keptStudents.length,
          deletedPreviewCount: recordsToDelete.length,
          auditReport
        })
      );
    } catch {}
  }

  let deletedStudentDocsCount = 0;
  let cleanedVariantDocsCount = 0;

  // Ensure auth before Firestore mutations
  if (db) {
    try {
      let authStatus = await ensureFirebaseAuthSessionWithStatus();
      if (!authStatus.user && auth && !auth.currentUser) {
        try {
          await signInAnonymously(auth);
        } catch (anonErr: any) {
          const d = extractFirestoreErrorDetails(anonErr);
          warnings.push(`Xác thực Auth: ${d.message}`);
        }
      }
    } catch {}
  }

  if (db) {
    const safeClassKey = sanitizeFirestoreDocId(classKey, classKey);
    const nowIso = new Date().toISOString();
    const maleCount = keptStudents.filter((s) => s.gender === 'Nam').length;
    const femaleCount = keptStudents.filter((s) => s.gender === 'Nữ').length;
    const cleanKeptForFirestore = keptStudents.map((s) =>
      sanitizeForFirestore({
        ...s,
        classKey,
        className,
        grade: 'Khối 5',
        updatedAt: nowIso
      })
    );

    // 1. Update canonical `class_rosters/{KEY}` with ONLY kept students (overwrite array cleanly)
    try {
      await trackedSetDoc(
        doc(db, 'class_rosters', safeClassKey),
        sanitizeForFirestore({
          className,
          classKey,
          grade: 'Khối 5',
          totalStudents: cleanKeptForFirestore.length,
          male: maleCount,
          female: femaleCount,
          students: cleanKeptForFirestore,
          updatedAt: nowIso
        }),
        undefined,
        { isUserInitiated: true, actionType: 'admin_batch' }
      );
    } catch (err: any) {
      const details = extractFirestoreErrorDetails(err);
      errors.push(`class_rosters/${safeClassKey}: ${details.message}`);
    }

    // 1b. Delete or empty non-canonical `class_rosters` variant docs (e.g. `5d`, `Lớp 5D`)
    const classRosterVariants = new Set<string>([
      ...variantRosterDocsToClean.filter((v) => v.collection === 'class_rosters').map((v) => v.docId),
      classKey.toLowerCase()
    ]);
    for (const vid of classRosterVariants) {
      if (!vid || vid === safeClassKey) continue;
      try {
        const snap = await getDoc(doc(db, 'class_rosters', vid));
        if (snap.exists()) {
          try {
            await trackedDeleteDoc(doc(db, 'class_rosters', vid), { isUserInitiated: true, actionType: 'admin_batch' });
            cleanedVariantDocsCount++;
          } catch {
            // Fallback: empty the variant doc if delete is rejected
            await trackedSetDoc(
              doc(db, 'class_rosters', vid),
              sanitizeForFirestore({
                className,
                classKey: vid,
                grade: 'Khối 5',
                totalStudents: 0,
                male: 0,
                female: 0,
                students: [],
                updatedAt: nowIso
              }),
              undefined,
              { isUserInitiated: true, actionType: 'admin_batch' }
            );
            cleanedVariantDocsCount++;
          }
        }
      } catch (err: any) {
        const details = extractFirestoreErrorDetails(err);
        warnings.push(`class_rosters/${vid}: ${details.message}`);
      }
    }

    // 2. Delete old duplicate documents from `students` collection (ONLY approved old/duplicate docs, NEVER kept <100)
    try {
      const docIdsToDelete = new Set<string>();
      recordsToDelete.forEach((rec) => {
        rec.studentDocIdsToDelete.forEach((docId) => {
          const normDocCode = normalizeStudentCode(docId);
          if (!keptCodesSet.has(normDocCode)) {
            docIdsToDelete.add(docId);
          }
        });
      });

      // Also scan `students` collection to ensure no lingering old 1xx doc belonging to this class was missed
      try {
        const allStudentsSnap = await getDocs(collection(db, 'students'));
        allStudentsSnap.forEach((docSnap) => {
          const data = docSnap.data() as any;
          if (!recordBelongsToClass(data, docSnap.id, classKey)) return;
          const normCode = normalizeStudentCode(data?.studentCode || data?.code || docSnap.id);
          const normName = normalizeStudentName(data?.fullName || data?.name);
          const isExplicitOldCode = oldCodesToDeleteSet.has(normCode);
          const isUnkept1xx = isOld1xxStudentCode({ ...data, code: data?.code || docSnap.id }) && !keptCodesSet.has(normCode);
          if ((isExplicitOldCode || isUnkept1xx) && !keptCodesSet.has(normCode)) {
            docIdsToDelete.add(docSnap.id);
          } else if (!keptCodesSet.has(normCode) && recordsToDelete.some((r) => r.normalizedName && r.normalizedName === normName && isOld1xxStudentCode({ code: normCode }))) {
            docIdsToDelete.add(docSnap.id);
          }
        });
      } catch {}

      // Also try direct doc lookups for old codes & variants
      for (const oldRec of recordsToDelete) {
        if (keptCodesSet.has(oldRec.normalizedCode)) continue;
        getStudentCodeLookupVariants(oldRec.code).forEach((v) => {
          if (!keptCodesSet.has(normalizeStudentCode(v))) {
            docIdsToDelete.add(v);
          }
        });
      }

      const deleteList = Array.from(docIdsToDelete);
      const BATCH_LIMIT = 450;
      for (let i = 0; i < deleteList.length; i += BATCH_LIMIT) {
        const chunk = deleteList.slice(i, i + BATCH_LIMIT);
        const batch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
        chunk.forEach((docId) => {
          batch.delete(doc(db, 'students', docId));
        });
        await batch.commit();
        deletedStudentDocsCount += chunk.length;
      }

      // Ensure all kept < 100 students exist cleanly in `students` collection
      for (let i = 0; i < cleanKeptForFirestore.length; i += BATCH_LIMIT) {
        const chunk = cleanKeptForFirestore.slice(i, i + BATCH_LIMIT);
        const batch = trackedWriteBatch(db, { isUserInitiated: true, actionType: 'admin_batch' });
        chunk.forEach((stDoc) => {
          const docId = sanitizeFirestoreDocId(
            stDoc.studentCode || stDoc.code || stDoc.id || `${classKey}_${stDoc.stt}`,
            `st_${classKey}_${stDoc.stt}`
          );
          batch.set(
            doc(db, 'students', docId),
            sanitizeForFirestore({
              ...stDoc,
              docId,
              classKey,
              className,
              grade: 'Khối 5',
              updatedAt: nowIso
            }),
            { merge: true }
          );
        });
        await batch.commit();
      }
    } catch (err: any) {
      const details = extractFirestoreErrorDetails(err);
      errors.push(`students: ${details.message}`);
    }

    // 3. Synchronize `public_rosters` (write clean kept roster & remove variant/old docs)
    const pubSyncRes = await syncPublicRosterToFirestore(className, cleanKeptForFirestore as StudentRecord[]);
    if (!pubSyncRes.success && pubSyncRes.error) {
      warnings.push(`public_rosters: ${pubSyncRes.error}`);
    }
    // Also clean any individual old docs in `public_rosters` if present
    const pubOldDocIds = new Set<string>();
    recordsToDelete.forEach((r) => r.publicDocIdsToDelete.forEach((id) => pubOldDocIds.add(id)));
    variantRosterDocsToClean
      .filter((v) => v.collection === 'public_rosters' && v.docId !== safeClassKey)
      .forEach((v) => pubOldDocIds.add(v.docId));
    for (const pId of pubOldDocIds) {
      if (!pId || pId === safeClassKey) continue;
      try {
        await trackedDeleteDoc(doc(db, 'public_rosters', pId), { isUserInitiated: true, actionType: 'admin_batch' });
        cleanedVariantDocsCount++;
      } catch {}
    }

    // 4. Keep `classes/{KEY}` totalStudents synchronized
    try {
      await trackedSetDoc(
        doc(db, 'classes', safeClassKey),
        sanitizeForFirestore({
          id: classKey,
          name: className,
          grade: 'Khối 5',
          totalStudents: cleanKeptForFirestore.length,
          updatedAt: nowIso
        }),
        { merge: true },
        { isUserInitiated: true, actionType: 'admin_batch' }
      );
    } catch {}
  }

  // 5. Clean ALL `localStorage` keys for this class (remove variants, rewrite canonical)
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(`eduplay_k5_cleared_${classKey}`);
      localStorage.removeItem(`eduplay_k5_cleared_${classKey.toLowerCase()}`);

      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('eduplay_k5_students_') && k !== EDUPLAY_STUDENTS_DB_KEY) {
          const suffix = k.replace('eduplay_k5_students_', '');
          if (normalizeClassKeyStrict(suffix) === classKey && k !== `eduplay_k5_students_${classKey}`) {
            keysToRemove.push(k);
          }
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(`eduplay_k5_students_${classKey}`, JSON.stringify(keptStudents));

      let fullDb: Record<string, StudentRecord[]> = {};
      const rawMaster = localStorage.getItem(EDUPLAY_STUDENTS_DB_KEY);
      if (rawMaster) {
        try {
          fullDb = JSON.parse(rawMaster) || {};
        } catch {
          fullDb = {};
        }
      }
      Object.keys(fullDb).forEach((k) => {
        if (normalizeClassKeyStrict(k) === classKey && k !== className && k !== classKey) {
          delete fullDb[k];
        }
      });
      fullDb[className] = keptStudents;
      fullDb[classKey] = keptStudents;
      localStorage.setItem(EDUPLAY_STUDENTS_DB_KEY, JSON.stringify(fullDb));

      window.dispatchEvent(
        new CustomEvent('student-data-updated', {
          detail: {
            className,
            classKey,
            count: keptStudents.length,
            students: keptStudents,
            action: 'dedup-cleaned',
            timestamp: Date.now()
          }
        })
      );
      window.dispatchEvent(
        new CustomEvent('eduplay_k5_students_updated', {
          detail: { className, classKey, count: keptStudents.length, action: 'dedup-cleaned' }
        })
      );
    } catch (err: any) {
      warnings.push(`localStorage: ${err?.message || String(err)}`);
    }
  }

  // 6. Clear IndexedDB tracking cache & memory cache
  try {
    clearMemoryTrackingData();
    await clearIndexedDBTrackingData();
  } catch (err: any) {
    warnings.push(`IndexedDB: ${err?.message || String(err)}`);
  }

  // BƯỚC 5: Re-inspect read-only after cleanup to report post-cleanup counts across ALL stores
  const afterReport = await inspectClassStudentDuplicatesAcrossStores(className);

  return {
    success: errors.length === 0,
    deletedOldCount: recordsToDelete.length,
    keptCount: keptStudents.length,
    deletedStudentDocsCount,
    cleanedVariantDocsCount,
    errors,
    warnings,
    backupStorageKey,
    beforeReport: auditReport,
    afterReport
  };
}
