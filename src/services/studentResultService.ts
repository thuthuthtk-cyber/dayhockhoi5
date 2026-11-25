import { doc, setDoc, getDocFromServer, getDoc, collection, getDocs, query, where, updateDoc, deleteDoc, deleteField } from 'firebase/firestore';
import { signInAnonymously } from 'firebase/auth';
import { db, auth, ensureFirebaseAuthSession } from './firebase';
import { normalizeStudentCode, getStudentCodeLookupVariants } from './studentCode';
import {
  sanitizeForFirestore,
  sanitizeFirestoreDocId,
  buildCompactEducationalMeta,
  withFirestoreTimeout
} from '../utils/firestoreSanitizer';

export const STUDENT_RESULTS_COLLECTION = 'student_results';

export interface StudentResultDocument {
  studentCode: string;
  updatedAt: string;
  exams?: Record<string, any>;
  assignments?: Record<string, any>;
  lessons?: Record<string, any>;
  games?: Record<string, any>;
  hocba?: Record<string, any>;
}

// Định nghĩa chính sách lưu trữ lần làm bài cho bài tập
type KeepAttemptPolicy = 'last' | 'best' | 'all';

interface AssignmentSubmissionPayload {
  assignmentId: string;
  score: number;
  maxScore: number;
  submittedAt: string;
  attemptNumber?: number;
  attemptsCount?: number;
  maxAttempts?: number;
  allowRetry?: boolean;
  allowRepeat?: boolean;
  status?: string;
  forceOverwrite?: boolean;
  answers?: Record<string, any>;
  answersById?: Record<string, any>;
  questionResults?: any[];
  keepAttempts?: KeepAttemptPolicy;
  studentName?: string;
  title?: string;
  subject?: string;
  rank?: string;
}

export interface StudentAssignmentResultLookup {
  found: boolean;
  result: any | null;
  attemptsCount: number;
  isGraded: boolean;
}

export function getAssignmentAttemptCountFromRecord(resData: any): number {
  if (!resData || typeof resData !== 'object') return 0;
  const explicitCount = Math.max(
    Number(resData.attemptsCount || 0) || 0,
    Number(resData.attempts || 0) || 0,
    Number(resData.attemptNumber || 0) || 0,
    Array.isArray(resData.attemptHistory) ? resData.attemptHistory.length : 0
  );
  if (explicitCount > 0) return explicitCount;
  if (
    resData.submittedAt ||
    resData.submittedTime ||
    resData.score !== undefined ||
    resData.totalScore !== undefined ||
    resData.graded === true ||
    resData.status === 'graded' ||
    resData.status === 'submitted'
  ) {
    return 1;
  }
  return 0;
}

function isAssignmentRecordGraded(resData: any): boolean {
  if (!resData || typeof resData !== 'object') return false;
  return Boolean(
    resData.graded === true ||
    resData.status === 'graded' ||
    resData.status === 'submitted' ||
    (resData.score !== undefined && resData.score !== null && resData.score !== '-') ||
    (resData.totalScore !== undefined && resData.totalScore !== null && resData.totalScore !== '-') ||
    resData.submittedAt ||
    resData.submittedTime
  );
}

async function ensureAuthSession(): Promise<void> {
  try {
    if (auth?.currentUser) return;
    await withFirestoreTimeout(ensureFirebaseAuthSession(), 6000, 'studentResultService.ensureAuth');
    if (auth && !auth.currentUser) {
      await withFirestoreTimeout(signInAnonymously(auth), 6000, 'studentResultService.signInAnonymously');
    }
  } catch (err) {
    console.warn('[studentResultService] Không thể tự động đăng nhập ẩn danh:', err);
  }
}

function compactSubmissionForFirestore(submissionData: any, studentCode: string, extraFields: Record<string, any>): Record<string, any> {
  const { exam, assignment, ...rest } = (submissionData && typeof submissionData === 'object') ? submissionData : {};
  const safeStudentName = typeof rest.studentName === 'string' ? rest.studentName.slice(0, 200) : '';
  const safeStudentCode = studentCode.slice(0, 64);

  return sanitizeForFirestore({
    ...rest,
    ...extraFields,
    studentCode: safeStudentCode,
    studentId: safeStudentCode,
    maHs: safeStudentCode,
    studentName: safeStudentName,
    ...(exam ? { exam: buildCompactEducationalMeta(exam) } : {}),
    ...(assignment ? { assignment: buildCompactEducationalMeta(assignment) } : {}),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Dịch vụ quản lý kết quả học tập tập trung theo studentCode
 */
export const studentResultService = {
  /**
   * Truy vấn toàn bộ kết quả bài tập đã nộp của học sinh theo studentCode chuẩn hóa (dùng where())
   */
  async getStudentResultsByCode(rawStudentCode: string): Promise<{
    studentCode: string;
    assignmentsMap: Record<string, any>;
    examsMap: Record<string, any>;
  }> {
    const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
    const emptyRes = { studentCode, assignmentsMap: {}, examsMap: {} };
    if (!studentCode || !db) return emptyRes;

    try {
      await ensureAuthSession();

      const variants = Array.from(
        new Set([studentCode, ...getStudentCodeLookupVariants(rawStudentCode)].filter(Boolean))
      ).slice(0, 10);

      const assignmentsMap: Record<string, any> = {};
      const examsMap: Record<string, any> = {};

      const mergeAssignEntry = (key: string, entry: any) => {
        if (!entry || typeof entry !== 'object') return;
        const entryId = String(entry.assignmentId || key || '').trim();
        if (!entryId) return;
        const safeKey = sanitizeFirestoreDocId(entryId, 'assignment');
        const prev = assignmentsMap[entryId] || assignmentsMap[safeKey];
        const prevAttempts = getAssignmentAttemptCountFromRecord(prev);
        const curAttempts = getAssignmentAttemptCountFromRecord(entry);
        const merged = {
          ...(prev || {}),
          ...entry,
          assignmentId: entryId,
          studentCode,
          attemptsCount: Math.max(prevAttempts, curAttempts),
          attempts: Math.max(prevAttempts, curAttempts),
          attemptNumber: Math.max(prevAttempts, curAttempts),
          graded: isAssignmentRecordGraded(entry) || Boolean(prev?.graded)
        };
        assignmentsMap[entryId] = merged;
        if (safeKey !== entryId) {
          assignmentsMap[safeKey] = merged;
        }
      };

      // 1. Truy vấn collection student_results bằng where() theo studentCode chuẩn hóa
      try {
        const colRef = collection(db, STUDENT_RESULTS_COLLECTION);
        const q = variants.length > 1
          ? query(colRef, where('studentCode', 'in', variants))
          : query(colRef, where('studentCode', '==', studentCode));
        const qSnap = await withFirestoreTimeout(getDocs(q), 8000, 'getStudentResultsByCode.where');
        qSnap.forEach((docSnap) => {
          const data = docSnap.data() || {};
          if (data.assignments && typeof data.assignments === 'object') {
            Object.entries(data.assignments).forEach(([k, val]) => mergeAssignEntry(k, val));
          }
          if (data.exams && typeof data.exams === 'object') {
            Object.entries(data.exams).forEach(([k, val]) => {
              examsMap[k] = val;
            });
          }
        });
      } catch (whereErr) {
        console.warn('[studentResultService] Lỗi query where() trên student_results:', whereErr);
      }

      // 2. Bổ sung đọc trực tiếp doc theo các biến thể mã HS & subcollection assignments
      const docCodeCandidates = Array.from(
        new Set(variants.map((v) => sanitizeFirestoreDocId(v, 'hs')).filter(Boolean))
      );

      await Promise.allSettled(
        docCodeCandidates.map(async (safeDocCode) => {
          try {
            const directRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode);
            const directSnap = await withFirestoreTimeout(getDoc(directRef), 6000, 'getStudentResultsByCode.getDoc');
            if (directSnap.exists()) {
              const data = directSnap.data() || {};
              if (data.assignments && typeof data.assignments === 'object') {
                Object.entries(data.assignments).forEach(([k, val]) => mergeAssignEntry(k, val));
              }
              if (data.exams && typeof data.exams === 'object') {
                Object.entries(data.exams).forEach(([k, val]) => {
                  examsMap[k] = val;
                });
              }
            }
          } catch {}

          try {
            const subColRef = collection(db, STUDENT_RESULTS_COLLECTION, safeDocCode, 'assignments');
            const subSnap = await withFirestoreTimeout(getDocs(subColRef), 6000, 'getStudentResultsByCode.subCol');
            subSnap.forEach((subDoc) => {
              const sData = subDoc.data() || {};
              const sCode = normalizeStudentCode(sData.studentCode || sData.studentId || sData.maHs || studentCode);
              if (sCode && sCode !== studentCode) return;
              mergeAssignEntry(sData.assignmentId || subDoc.id, sData);
            });
          } catch {}
        })
      );

      return { studentCode, assignmentsMap, examsMap };
    } catch (err) {
      console.warn('[studentResultService] Lỗi tải kết quả học sinh:', err);
      return emptyRes;
    }
  },

  /**
   * Kiểm tra nhanh kết quả & số lần làm của 1 học sinh cho 1 bài tập cụ thể
   */
  async getStudentAssignmentResult(
    rawStudentCode: string,
    assignmentId: string,
    originalAssignmentId?: string
  ): Promise<StudentAssignmentResultLookup> {
    const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
    const assignId = String(assignmentId || '').trim();
    if (!studentCode || !assignId || !db) {
      return { found: false, result: null, attemptsCount: 0, isGraded: false };
    }

    try {
      const { assignmentsMap } = await this.getStudentResultsByCode(studentCode);
      const candIds = Array.from(
        new Set([
          assignId,
          sanitizeFirestoreDocId(assignId, 'assignment'),
          originalAssignmentId ? String(originalAssignmentId).trim() : '',
          originalAssignmentId ? sanitizeFirestoreDocId(originalAssignmentId, 'assignment') : ''
        ].filter(Boolean))
      );

      for (const cid of candIds) {
        const matched = assignmentsMap[cid];
        if (matched) {
          const attemptsCount = Math.max(1, getAssignmentAttemptCountFromRecord(matched));
          return {
            found: true,
            result: matched,
            attemptsCount,
            isGraded: isAssignmentRecordGraded(matched)
          };
        }
      }

      // Kiểm tra thêm theo rootId không có hậu tố -class-
      const baseAssignId = assignId.replace(/-class-.*$/i, '');
      const matchedByValue = Object.values(assignmentsMap).find((entry: any) => {
        if (!entry) return false;
        const entryId = String(entry.assignmentId || entry.id || '').trim();
        if (!entryId) return false;
        return entryId === assignId || (originalAssignmentId && entryId === originalAssignmentId) || (baseAssignId && entryId.replace(/-class-.*$/i, '') === baseAssignId);
      });

      if (matchedByValue) {
        const attemptsCount = Math.max(1, getAssignmentAttemptCountFromRecord(matchedByValue));
        return {
          found: true,
          result: matchedByValue,
          attemptsCount,
          isGraded: isAssignmentRecordGraded(matchedByValue)
        };
      }

      return { found: false, result: null, attemptsCount: 0, isGraded: false };
    } catch (err) {
      console.warn('[studentResultService] Lỗi kiểm tra kết quả bài tập:', err);
      return { found: false, result: null, attemptsCount: 0, isGraded: false };
    }
  },

  /**
   * Xóa vĩnh viễn toàn bộ bản ghi kết quả của 1 studentCode thuộc 1 bài tập trong `student_results`
   * (truy vấn bằng where(), xử lý cả bản ghi trùng lặp, subcollection `assignments`, và map `assignments`).
   */
  async deleteAssignmentResult(
    rawStudentCode: string,
    assignmentId: string,
    originalAssignmentId?: string
  ): Promise<{ deletedCount: number }> {
    const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
    const assignId = String(assignmentId || '').trim();
    if (!studentCode || !assignId || !db) {
      return { deletedCount: 0 };
    }

    let deletedCount = 0;

    try {
      await ensureAuthSession();

      const variants = Array.from(
        new Set([studentCode, ...getStudentCodeLookupVariants(rawStudentCode)].filter(Boolean))
      ).slice(0, 10);

      const assignIds = Array.from(
        new Set([
          assignId,
          sanitizeFirestoreDocId(assignId, 'assignment'),
          originalAssignmentId ? String(originalAssignmentId).trim() : '',
          originalAssignmentId ? sanitizeFirestoreDocId(originalAssignmentId, 'assignment') : ''
        ].filter(Boolean))
      );
      const assignIdSet = new Set(assignIds.map((id) => id.toLowerCase()));

      const isMatchingAssignEntry = (key: string, val?: any): boolean => {
        const kLow = String(key || '').trim().toLowerCase();
        const safeKLow = kLow ? sanitizeFirestoreDocId(key, 'assignment').toLowerCase() : '';
        if (assignIdSet.has(kLow) || (safeKLow && assignIdSet.has(safeKLow))) return true;
        if (val && typeof val === 'object') {
          const valIds = [val.assignmentId, val.id, val.assignment?.id]
            .filter(Boolean)
            .map((v) => String(v).trim());
          for (const vid of valIds) {
            const vidLow = vid.toLowerCase();
            const safeVidLow = sanitizeFirestoreDocId(vid, 'assignment').toLowerCase();
            if (assignIdSet.has(vidLow) || assignIdSet.has(safeVidLow)) return true;
          }
        }
        return false;
      };

      const targetDocIds = new Set<string>();

      // 1. Truy vấn collection student_results bằng where() theo studentCode / studentId / maHs
      const whereFields = ['studentCode', 'studentId', 'maHs'] as const;
      await Promise.allSettled(
        whereFields.map(async (field) => {
          try {
            const colRef = collection(db, STUDENT_RESULTS_COLLECTION);
            const q = variants.length > 1
              ? query(colRef, where(field, 'in', variants))
              : query(colRef, where(field, '==', studentCode));
            const qSnap = await withFirestoreTimeout(getDocs(q), 8000, `deleteAssignmentResult.where.${field}`);
            qSnap.forEach((docSnap) => {
              const data = docSnap.data() || {};
              const docCode = normalizeStudentCode(data.studentCode || data.studentId || data.maHs || docSnap.id);
              if (!docCode || docCode === studentCode) {
                targetDocIds.add(docSnap.id);
              }
            });
          } catch (err) {
            console.warn(`[studentResultService] Lỗi query where(${field}) khi xóa:`, err);
          }
        })
      );

      // 2. Bổ sung các docId theo mã chuẩn hóa & biến thể an toàn
      variants.forEach((v) => {
        if (v) targetDocIds.add(v);
        const safeV = sanitizeFirestoreDocId(v, 'hs');
        if (safeV) targetDocIds.add(safeV);
      });

      // 3. Xóa trên từng document student_results và subcollection assignments/{id}
      await Promise.allSettled(
        Array.from(targetDocIds).map(async (docId) => {
          const srDocRef = doc(db, STUDENT_RESULTS_COLLECTION, docId);

          // 3a. Xóa trong subcollection student_results/{docId}/assignments bằng where() + quét subcollection
          try {
            const subColRef = collection(db, STUDENT_RESULTS_COLLECTION, docId, 'assignments');
            const subIdsToDelete = new Set<string>();

            try {
              const qSub = assignIds.length > 1
                ? query(subColRef, where('assignmentId', 'in', assignIds.slice(0, 10)))
                : query(subColRef, where('assignmentId', '==', assignId));
              const subWhereSnap = await withFirestoreTimeout(getDocs(qSub), 6000, 'deleteAssignmentResult.subWhere');
              subWhereSnap.forEach((d) => subIdsToDelete.add(d.id));
            } catch {}

            try {
              const allSubSnap = await withFirestoreTimeout(getDocs(subColRef), 6000, 'deleteAssignmentResult.subAll');
              allSubSnap.forEach((d) => {
                if (isMatchingAssignEntry(d.id, d.data())) {
                  subIdsToDelete.add(d.id);
                }
              });
            } catch {}

            assignIds.forEach((aid) => subIdsToDelete.add(aid));

            await Promise.allSettled(
              Array.from(subIdsToDelete).map(async (subId) => {
                try {
                  const subRef = doc(db, STUDENT_RESULTS_COLLECTION, docId, 'assignments', subId);
                  await withFirestoreTimeout(deleteDoc(subRef), 5000, 'deleteAssignmentResult.deleteSubDoc');
                  deletedCount++;
                } catch {}
              })
            );
          } catch {}

          // 3b. Xóa trong document gốc student_results/{docId}
          try {
            const srSnap = await withFirestoreTimeout(getDoc(srDocRef), 6000, 'deleteAssignmentResult.getDoc');
            if (!srSnap.exists()) return;
            const data = srSnap.data() || {};

            // Trường hợp bản ghi phẳng lưu trực tiếp 1 kết quả bài tập tại root student_results
            const rootAssignId = String(data.assignmentId || '').trim();
            const isFlatSingleAssignmentDoc = Boolean(
              rootAssignId && isMatchingAssignEntry(rootAssignId, data) &&
              (!data.assignments || typeof data.assignments !== 'object')
            );

            if (isFlatSingleAssignmentDoc) {
              await withFirestoreTimeout(deleteDoc(srDocRef), 6000, 'deleteAssignmentResult.deleteFlatDoc');
              deletedCount++;
              return;
            }

            if (data.assignments && typeof data.assignments === 'object') {
              const matchedKeys = Object.entries(data.assignments)
                .filter(([k, val]) => isMatchingAssignEntry(k, val))
                .map(([k]) => k);

              if (matchedKeys.length > 0) {
                const remainingAssignKeys = Object.keys(data.assignments).filter((k) => !matchedKeys.includes(k));
                const hasOtherSections = Boolean(
                  (data.exams && Object.keys(data.exams).length > 0) ||
                  (data.lessons && Object.keys(data.lessons).length > 0) ||
                  (data.games && Object.keys(data.games).length > 0) ||
                  (data.hocba && Object.keys(data.hocba).length > 0)
                );

                if (remainingAssignKeys.length === 0 && !hasOtherSections) {
                  await withFirestoreTimeout(deleteDoc(srDocRef), 6000, 'deleteAssignmentResult.deleteEmptySrDoc');
                  deletedCount++;
                } else {
                  const updateFields: Record<string, any> = {
                    updatedAt: new Date().toISOString(),
                  };
                  matchedKeys.forEach((k) => {
                    updateFields[`assignments.${k}`] = deleteField();
                  });
                  await withFirestoreTimeout(updateDoc(srDocRef, updateFields), 6000, 'deleteAssignmentResult.deleteField');
                  deletedCount += matchedKeys.length;
                }
              }
            }
          } catch (docErr) {
            console.warn(`[studentResultService] Lỗi xóa trong doc student_results/${docId}:`, docErr);
          }
        })
      );

      return { deletedCount };
    } catch (err) {
      console.warn('[studentResultService] Lỗi deleteAssignmentResult:', err);
      return { deletedCount };
    }
  },

  /**
   * Lưu kết quả làm bài tập của học sinh
   * Cập nhật chính xác số lần làm (attemptsCount / attemptNumber) và khóa khi bài chỉ cho phép 1 lần hoặc đã chấm điểm.
   */
  async saveAssignmentResult(
    rawStudentCode: string,
    payload: AssignmentSubmissionPayload
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');
      if (!payload?.assignmentId) throw new Error('Mã bài tập không hợp lệ');

      await ensureAuthSession();

      const safeDocCode = sanitizeFirestoreDocId(studentCode, 'hs');
      const safeAssignKey = sanitizeFirestoreDocId(payload.assignmentId, 'assignment');
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode);
      const policy: KeepAttemptPolicy = payload.keepAttempts || 'last';
      const safeScore = Number.isFinite(Number(payload.score)) ? Number(payload.score) : 0;
      const safeMaxScore = Number.isFinite(Number(payload.maxScore)) ? Number(payload.maxScore) : 10;
      const safeSubmittedAt = payload.submittedAt || new Date().toISOString();
      const safeAnswers = sanitizeForFirestore(payload.answers || {});

      let prevAttempts = 0;
      let prevGraded = false;
      try {
        const existingSnap = await withFirestoreTimeout(getDoc(docRef), 5000, 'saveAssignmentResult.readExisting');
        if (existingSnap.exists()) {
          const prevEntry = existingSnap.data()?.assignments?.[safeAssignKey] || existingSnap.data()?.assignments?.[payload.assignmentId];
          prevAttempts = getAssignmentAttemptCountFromRecord(prevEntry);
          prevGraded = isAssignmentRecordGraded(prevEntry);
        }
      } catch (readErr) {
        console.warn('[studentResultService] Không đọc được số lần làm trước đó:', readErr);
      }

      const isSingleAttemptPolicy =
        payload.allowRetry === false ||
        payload.allowRepeat === false ||
        payload.maxAttempts === 1;

      if (isSingleAttemptPolicy && (prevAttempts >= 1 || prevGraded) && !payload.forceOverwrite) {
        console.warn(`[studentResultService] Bài tập ${payload.assignmentId} chỉ cho phép 1 lần và học sinh ${studentCode} đã hoàn thành/chấm điểm.`);
        return false;
      }

      const explicitAttempt = Number.isFinite(Number(payload.attemptsCount || payload.attemptNumber))
        ? Number(payload.attemptsCount || payload.attemptNumber)
        : 0;
      const nextAttempts = Math.max(explicitAttempt, prevAttempts + 1, 1);

      const assignmentData: any = {
        assignmentId: String(payload.assignmentId),
        studentCode,
        score: safeScore,
        totalScore: safeScore,
        maxScore: safeMaxScore,
        submittedAt: safeSubmittedAt,
        attemptNumber: nextAttempts,
        attempts: nextAttempts,
        attemptsCount: nextAttempts,
        status: payload.status || 'graded',
        graded: true,
        ...(payload.answersById ? { answersById: sanitizeForFirestore(payload.answersById) } : {}),
        ...(Array.isArray(payload.questionResults) ? { questionResults: sanitizeForFirestore(payload.questionResults) } : {}),
        ...(payload.title ? { title: String(payload.title).slice(0, 500) } : {}),
        ...(payload.subject ? { subject: String(payload.subject) } : {}),
        ...(payload.rank ? { rank: String(payload.rank) } : {}),
      };

      // Nếu chính sách là 'last', chỉ lưu câu trả lời hoặc chi tiết của lần nộp mới nhất
      if (policy === 'last') {
        assignmentData.answers = safeAnswers;
        assignmentData.lastAttempt = {
          score: safeScore,
          submittedAt: safeSubmittedAt,
          answers: safeAnswers,
          attemptNumber: nextAttempts,
        };
      } else if (policy === 'best') {
        assignmentData.bestScore = safeScore;
      }

      const updatePayload = sanitizeForFirestore({
        studentCode,
        assignments: {
          [safeAssignKey]: assignmentData,
        },
        updatedAt: new Date().toISOString(),
      });

      // Thực hiện ghi an toàn bằng setDoc merge kèm timeout
      await withFirestoreTimeout(
        setDoc(docRef, updatePayload, { merge: true }),
        10000,
        'saveAssignmentResult.setDoc'
      );

      // Xác thực không chặn nếu server phản hồi chậm hoặc đang offline
      try {
        await withFirestoreTimeout(getDocFromServer(docRef), 4000, 'saveAssignmentResult.verify');
      } catch (verifyErr) {
        console.warn('Xác thực getDocFromServer tạm bỏ qua (mạng chậm/offline):', verifyErr);
      }

      return true;
    } catch (error) {
      console.error('Lỗi khi lưu kết quả bài tập:', error);
      throw error;
    }
  },

  /**
   * Lưu kết quả bài kiểm tra (Exams)
   */
  async saveExamResult(
    rawStudentCode: string,
    examId: string,
    resultData: { score: number; maxScore: number; submittedAt: string; type?: string }
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      await ensureAuthSession();

      const safeDocCode = sanitizeFirestoreDocId(studentCode, 'hs');
      const safeExamKey = sanitizeFirestoreDocId(examId, 'exam');
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode);
      const safeScore = Number.isFinite(Number(resultData?.score)) ? Number(resultData.score) : 0;
      const safeMaxScore = Number.isFinite(Number(resultData?.maxScore)) ? Number(resultData.maxScore) : 10;

      const updatePayload = sanitizeForFirestore({
        studentCode,
        exams: {
          [safeExamKey]: {
            ...resultData,
            examId: String(examId),
            studentCode,
            score: safeScore,
            maxScore: safeMaxScore,
            submittedAt: resultData?.submittedAt || new Date().toISOString(),
            type: resultData?.type || 'exam',
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      });

      await withFirestoreTimeout(
        setDoc(docRef, updatePayload, { merge: true }),
        10000,
        'saveExamResult.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu kết quả kiểm tra:', error);
      throw error;
    }
  },

  /**
   * Lưu kết quả trò chơi / đấu trường (Games)
   */
  async saveGameResult(
    rawStudentCode: string,
    gameId: string,
    resultData: {
      score: number;
      maxScore: number;
      rank: number | 'unranked';
      submittedAt: string;
      completed?: boolean;
      questionsAnswered?: number;
      totalQuestions?: number;
      studentName?: string;
      className?: string;
      roomId?: string;
      roomTitle?: string;
    }
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      await ensureAuthSession();

      const safeDocCode = sanitizeFirestoreDocId(studentCode, 'hs');
      const safeGameKey = sanitizeFirestoreDocId(gameId, 'game');
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode);

      const updatePayload = sanitizeForFirestore({
        studentCode,
        games: {
          [safeGameKey]: {
            ...resultData,
            studentCode,
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      });

      await withFirestoreTimeout(
        setDoc(docRef, updatePayload, { merge: true }),
        10000,
        'saveGameResult.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu kết quả trò chơi:', error);
      throw error;
    }
  },

  /**
   * Tải kết quả bài kiểm tra (Exams) từ Firestore
   */
  async getExamSubmission(rawStudentCode: string, examId: string): Promise<any | null> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode || !examId) return null;

      await ensureAuthSession();

      const safeDocCode = sanitizeFirestoreDocId(studentCode, 'hs');
      const safeExamId = sanitizeFirestoreDocId(examId, 'exam');
      // Fetch from: student_results/{studentCode}/exams/{examId}
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode, 'exams', safeExamId);
      const snap = await withFirestoreTimeout(getDoc(docRef), 8000, 'getExamSubmission');
      return snap.exists() ? snap.data() : null;
    } catch (error) {
      console.error('Lỗi khi tải bài kiểm tra từ Firestore:', error);
      return null;
    }
  },

  /**
   * Lưu toàn bộ kết quả bài kiểm tra (Exams) lên Firestore
   */
  async saveFullExamSubmission(
    rawStudentCode: string,
    examId: string,
    submissionData: any
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      await ensureAuthSession();

      const safeDocCode = sanitizeFirestoreDocId(studentCode, 'hs');
      const safeExamId = sanitizeFirestoreDocId(examId, 'exam');
      // Save to: student_results/{studentCode}/exams/{examId}
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode, 'exams', safeExamId);
      const sanitizedPayload = compactSubmissionForFirestore(submissionData, studentCode, {
        examId: String(examId),
      });

      await withFirestoreTimeout(
        setDoc(docRef, sanitizedPayload, { merge: true }),
        10000,
        'saveFullExamSubmission.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu bài kiểm tra vào Firestore:', error);
      throw error;
    }
  },

  /**
   * Lưu toàn bộ kết quả bài tập (Assignments) lên Firestore
   */
  async saveFullAssignmentSubmission(
    rawStudentCode: string,
    assignmentId: string,
    submissionData: any
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode).slice(0, 64);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      await ensureAuthSession();

      const safeDocCode = sanitizeFirestoreDocId(studentCode, 'hs');
      const safeAssignId = sanitizeFirestoreDocId(assignmentId, 'assignment');
      // Save to: student_results/{studentCode}/assignments/{assignmentId}
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, safeDocCode, 'assignments', safeAssignId);

      let prevAttempts = 0;
      try {
        const existingSnap = await withFirestoreTimeout(getDoc(docRef), 4500, 'saveFullAssignmentSubmission.readExisting');
        if (existingSnap.exists()) {
          prevAttempts = getAssignmentAttemptCountFromRecord(existingSnap.data());
        }
      } catch {}

      const explicitAttempts = Math.max(
        Number(submissionData?.attemptsCount || 0) || 0,
        Number(submissionData?.attempts || 0) || 0,
        Number(submissionData?.attemptNumber || 0) || 0
      );
      const nextAttempts = Math.max(explicitAttempts, prevAttempts > 0 ? prevAttempts : 1, 1);

      const sanitizedPayload = compactSubmissionForFirestore(submissionData, studentCode, {
        assignmentId: String(assignmentId),
        attemptNumber: nextAttempts,
        attempts: nextAttempts,
        attemptsCount: nextAttempts,
        status: submissionData?.status || 'graded',
        graded: true,
      });

      await withFirestoreTimeout(
        setDoc(docRef, sanitizedPayload, { merge: true }),
        10000,
        'saveFullAssignmentSubmission.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu bài tập vào Firestore:', error);
      throw error;
    }
  }
};

