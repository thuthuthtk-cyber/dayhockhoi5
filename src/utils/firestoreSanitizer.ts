import { QuestionItem } from '../types';

/**
 * Recursively sanitizes any value for Firestore writes:
 * - Converts `undefined` (at root, in objects, and in arrays) to `null`
 * - Converts `NaN` and non-finite numbers (`Infinity`, `-Infinity`) to `null`
 * - Converts `Date` instances to ISO strings
 * - Strips unsupported values (`function`, `symbol`) cleanly
 * - Preserves array indices/lengths (never drops sparse slots by filtering)
 */
export function sanitizeForFirestore<T>(value: T): T {
  if (value === undefined || value === null) {
    return null as unknown as T;
  }

  if (typeof value === 'number') {
    return (Number.isFinite(value) ? value : null) as unknown as T;
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'bigint') {
    return String(value) as unknown as T;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return null as unknown as T;
  }

  if (value instanceof Date) {
    return (Number.isNaN(value.getTime()) ? null : value.toISOString()) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item)) as unknown as T;
  }

  if (typeof value === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(value as Record<string, any>)) {
      if (typeof val === 'function' || typeof val === 'symbol') {
        continue;
      }
      cleaned[key] = sanitizeForFirestore(val);
    }
    return cleaned as T;
  }

  return null as unknown as T;
}

function isTrueFalseMulti(q?: QuestionItem): boolean {
  if (!q) return false;
  return Boolean(Array.isArray(q.statements) && q.statements.length > 0);
}

function normalizeQuestionAnswerValue(rawChoice: any, q?: QuestionItem): any {
  if (rawChoice === undefined || rawChoice === null) {
    if (isTrueFalseMulti(q) && q?.statements) {
      const emptyMap: Record<string, boolean | null> = {};
      q.statements.forEach((_, sIdx) => {
        emptyMap[String(sIdx)] = null;
      });
      return emptyMap;
    }
    return null;
  }

  // True/False multi-statement object -> normalize keys "0", "1", ... to boolean | null
  if (isTrueFalseMulti(q) && q?.statements) {
    const src = typeof rawChoice === 'object' && rawChoice !== null ? rawChoice : {};
    const normalizedMap: Record<string, boolean | null> = {};
    q.statements.forEach((_, sIdx) => {
      const val = src[sIdx] !== undefined ? src[sIdx] : src[String(sIdx)];
      if (val === true || val === 'true') {
        normalizedMap[String(sIdx)] = true;
      } else if (val === false || val === 'false') {
        normalizedMap[String(sIdx)] = false;
      } else {
        normalizedMap[String(sIdx)] = null;
      }
    });
    return normalizedMap;
  }

  if (typeof rawChoice === 'number') {
    return Number.isFinite(rawChoice) ? rawChoice : null;
  }

  if (typeof rawChoice === 'boolean' || typeof rawChoice === 'string') {
    return rawChoice;
  }

  if (Array.isArray(rawChoice)) {
    return rawChoice.map((item) => sanitizeForFirestore(item));
  }

  if (typeof rawChoice === 'object') {
    const normalizedObj: Record<string, any> = {};
    for (const [k, v] of Object.entries(rawChoice)) {
      normalizedObj[String(k)] = sanitizeForFirestore(v);
    }
    return normalizedObj;
  }

  return null;
}

/**
 * Normalizes the entire student answers map & builds a clean `answersById` map
 * guaranteed to contain zero `undefined` or `NaN` values across all question types
 * (multiple choice, true/false multi-statement, multiple response, matching, ordering,
 * classification, fill-in-the-blank, essay).
 */
export function normalizeSubmissionAnswers(
  rawAnswers: Record<number | string, any> | undefined | null,
  questions?: QuestionItem[]
): {
  answers: Record<string, any>;
  answersById: Record<string, any>;
} {
  const source = rawAnswers && typeof rawAnswers === 'object' ? rawAnswers : {};
  const normalizedAnswers: Record<string, any> = {};
  const answersById: Record<string, any> = {};

  const qList = Array.isArray(questions) ? questions : [];

  qList.forEach((q, idx) => {
    const rawVal = source[idx] !== undefined ? source[idx] : source[String(idx)];
    const cleanVal = normalizeQuestionAnswerValue(rawVal, q);
    normalizedAnswers[String(idx)] = cleanVal;
    const qKey = String(q?.id || `q_${idx}`);
    answersById[qKey] = cleanVal;
  });

  // Preserve any extra answer indices not covered by qList length
  for (const [k, v] of Object.entries(source)) {
    if (normalizedAnswers[String(k)] === undefined) {
      normalizedAnswers[String(k)] = sanitizeForFirestore(v);
    }
  }

  return {
    answers: sanitizeForFirestore(normalizedAnswers),
    answersById: sanitizeForFirestore(answersById),
  };
}

/**
 * Wraps an async promise (e.g., Firestore setDoc / runTransaction / getDoc)
 * with a deterministic timeout so slow/stalled networks never hang loading UI forever.
 */
export function withFirestoreTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = 10000,
  operationLabel: string = 'Firestore operation'
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error(`FIRESTORE_TIMEOUT:${operationLabel}:${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  });
}

/**
 * Ensures a Firestore document ID satisfies `isValidId(id)`:
 * `id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_.@-]+$')`
 */
export function sanitizeFirestoreDocId(rawId: string | undefined | null, fallback = 'doc'): string {
  const normalized = String(rawId || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.@-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const base = normalized || fallback;
  if (base.length <= 120) return base;

  // Deterministic short hash suffix when truncating long IDs to preserve uniqueness
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash + base.charCodeAt(i)) | 0;
  }
  const suffix = Math.abs(hash).toString(36).slice(0, 8);
  return `${base.slice(0, 110)}_${suffix}`;
}

/**
 * Strips heavy/nested `submissions` arrays and redundant fields from an exam/assignment object
 * before embedding metadata inside a submission document so Firestore stays well under 1MB.
 */
export function buildCompactEducationalMeta(source: any): Record<string, any> | null {
  if (!source || typeof source !== 'object') return null;
  const meta: Record<string, any> = {
    id: String(source.id || ''),
    title: String(source.title || '').slice(0, 500),
    subject: String(source.subject || ''),
    grade: String(source.grade || ''),
    durationMinutes: Number.isFinite(Number(source.durationMinutes)) ? Number(source.durationMinutes) : null,
    examType: source.examType || null,
    targetClass: source.targetClass || null,
    originalExamId: source.originalExamId || null,
    originalAssignmentId: source.originalAssignmentId || null,
    teacherId: source.teacherId || null,
    teacherName: source.teacherName || null,
  };
  return sanitizeForFirestore(meta);
}

