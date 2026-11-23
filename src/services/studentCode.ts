/**
 * Tiện ích quản lý và chuẩn hóa Mã học sinh duy nhất theo định dạng chuẩn: Lớp-NămHọc-STT (Ví dụ: 5D26-27-1)
 * Quy tắc: Khóa duy nhất của học sinh là Mã HS dạng 5D26-27-1 (lớp, năm học, số thứ tự). 
 * Không dùng sddcn, studentId cũ, tên hay mã khác.
 */

export interface ParsedStudentCode {
  className: string;      // e.g. "5D"
  academicYear: string;   // e.g. "2026-2027" (represented as "26-27")
  stt: number;            // e.g. 1
  raw: string;            // normalized raw string
}

/**
 * Giữ nguyên định dạng mã học sinh đã lưu (chỉ loại bỏ khoảng trắng thừa, chuẩn hóa dấu gạch ngang, viết hoa),
 * KHÔNG tự ý đổi mã đã lưu (ví dụ giữ nguyên cả "5C26-27-01" lẫn "5C26-27-1").
 */
export function preserveRawStudentCode(code?: string): string {
  if (!code || typeof code !== 'string') return '';
  return code
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, '')
    .trim()
    .toUpperCase();
}

/**
 * Chuẩn hóa mã học sinh để đối chiếu / đọc / tìm kiếm:
 * - Loại bỏ khoảng trắng thừa, chuẩn hóa dấu gạch ngang, viết hoa toàn bộ.
 * - Hỗ trợ cả 2 cách viết có số 0 ở STT và không có số 0 ở STT:
 *   "5C26-27-01" -> "5C26-27-1", "5C26-27-1" -> "5C26-27-1".
 */
export function normalizeStudentCode(code?: string): string {
  const clean = preserveRawStudentCode(code);
  if (!clean) return '';
  const stdMatch = clean.match(/^([A-Z0-9]+\d{2}-\d{2}-)0*(\d+)$/);
  if (stdMatch) {
    const num = parseInt(stdMatch[2], 10);
    if (!isNaN(num) && num >= 0) {
      return `${stdMatch[1]}${num}`;
    }
  }
  return clean;
}

/**
 * Trả về các biến thể tra cứu của Mã HS (hỗ trợ cả dạng có 0 và không có 0 ở STT < 10)
 * để đọc/khớp dữ liệu cũ mà không thay đổi mã gốc đã lưu.
 */
export function getStudentCodeLookupVariants(code?: string): string[] {
  const raw = preserveRawStudentCode(code);
  const canonical = normalizeStudentCode(code);
  if (!raw && !canonical) return [];
  const variants = new Set<string>();
  if (raw) variants.add(raw);
  if (canonical) variants.add(canonical);
  const match = canonical.match(/^([A-Z0-9]+\d{2}-\d{2}-)(\d+)$/);
  if (match) {
    const num = parseInt(match[2], 10);
    if (!isNaN(num) && num > 0 && num < 10) {
      variants.add(`${match[1]}${String(num).padStart(2, '0')}`);
    }
  }
  return Array.from(variants);
}

/**
 * So khớp 2 Mã HS bất kể cách viết có số 0 đứng đầu hay không (5C26-27-01 === 5C26-27-1)
 */
export function areStudentCodesEqual(a?: string, b?: string): boolean {
  const normA = normalizeStudentCode(a);
  const normB = normalizeStudentCode(b);
  return Boolean(normA && normB && normA === normB);
}

/**
 * Chuẩn hóa họ tên học sinh: bỏ dấu tiếng Việt, bỏ khoảng trắng thừa, chuyển về chữ thường để so khớp chính xác.
 * Ví dụ: "  TRẦN   MINH  ĐỨC  " -> "tran minh duc", "Trần Minh Đức" -> "tran minh duc"
 */
export function normalizeStudentName(name?: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kiểm tra mã học sinh có hợp lệ theo định dạng chuẩn hay không.
 * Định dạng mẫu: ^[A-Z0-9]+\d{2}-\d{2}-\d+$ (Ví dụ: 5D26-27-1, 5D26-27-01, 5C26-27-36)
 */
export function isValidStudentCode(code?: string): boolean {
  if (!code || typeof code !== 'string') return false;
  const normalized = preserveRawStudentCode(code);
  const regex = /^[A-Z0-9]+\d{2}-\d{2}-\d+$/;
  return regex.test(normalized);
}

/**
 * Tạo mã học sinh mới dựa trên lớp, năm học và số thứ tự lớn nhất hiện có + 1.
 * Quy ước khuyến nghị thống nhất: không đệm số 0 ở đầu STT (ví dụ: 5D26-27-1).
 * Đảm bảo số thứ tự cấp một lần, không dùng lại số cũ.
 */
export function generateStudentCode(className: string, academicYear: string = '2026-2027', existingStts: number[] = []): { code: string; stt: number } {
  // 1. Chuẩn hóa tên lớp (ví dụ "Lớp 5D" -> "5D", "5d" -> "5D")
  let cleanClass = (className || '').trim().replace(/\s+/g, ' ');
  while (/^(lớp|lop)\b[\s:_-]*/i.test(cleanClass)) {
    cleanClass = cleanClass.replace(/^(lớp|lop)\b[\s:_-]*/i, '').trim();
  }
  cleanClass = cleanClass.replace(/\s+/g, '').toUpperCase();

  // 2. Chuẩn hóa năm học (ví dụ "2026-2027" -> "26-27")
  let yearCode = '26-27';
  if (academicYear.includes('2026')) {
    yearCode = '26-27';
  } else if (academicYear.includes('-')) {
    const parts = academicYear.split('-');
    if (parts.length === 2) {
      const y1 = parts[0].trim().slice(-2);
      const y2 = parts[1].trim().slice(-2);
      yearCode = `${y1}-${y2}`;
    }
  }

  // 3. Tính số thứ tự tiếp theo (lớn nhất + 1, tránh trùng lặp)
  let nextStt = 1;
  if (Array.isArray(existingStts) && existingStts.length > 0) {
    const validNums = existingStts.filter(n => typeof n === 'number' && !isNaN(n));
    if (validNums.length > 0) {
      const maxStt = Math.max(...validNums);
      nextStt = maxStt >= 1 ? maxStt + 1 : 1;
    }
  }

  const code = `${cleanClass}${yearCode}-${nextStt}`;
  return { code, stt: nextStt };
}

/**
 * Đọc và tách mã học sinh thành các thành phần: lớp, năm học, số thứ tự.
 */
export function parseStudentCode(code?: string): ParsedStudentCode | null {
  if (!isValidStudentCode(code)) return null;
  const normalized = normalizeStudentCode(code);

  // Ví dụ: 5D26-27-1 hoặc 5D26-27-01 -> className: 5D, academicYear: 26-27, stt: 1
  const match = normalized.match(/^([A-Z0-9]+)(\d{2}-\d{2})-(\d+)$/);
  if (!match) return null;

  return {
    className: match[1],
    academicYear: match[2],
    stt: parseInt(match[3], 10),
    raw: normalized
  };
}

/**
 * Chuẩn hóa biến thể của Mã học sinh về dạng chuẩn Lớp-NămHọc-STT (ví dụ: 5D26-27-1).
 * Nếu mã đã đúng định dạng chuẩn (kể cả dạng cũ có số 0 như 5C26-27-01), giữ nguyên mã đã lưu.
 */
export function formatStandardStudentCode(rawCode?: string, defaultClass: string = '5C', stt?: number): string {
  let cleanCls = (defaultClass || '5C').trim().replace(/\s+/g, ' ');
  while (/^(lớp|lop)\b[\s:_-]*/i.test(cleanCls)) {
    cleanCls = cleanCls.replace(/^(lớp|lop)\b[\s:_-]*/i, '').trim();
  }
  cleanCls = cleanCls.replace(/\s+/g, '').toUpperCase() || '5C';

  if (!rawCode && !stt) {
    return `${cleanCls}26-27-1`;
  }
  const clean = preserveRawStudentCode(rawCode);
  if (/^[A-Z0-9]+\d{2}-\d{2}-\d+$/.test(clean)) {
    return clean;
  }
  // Nếu là dạng 5C1, 5c1, st-5c-1, hs-5c-1, 5c-1
  const legacyMatch = clean.match(/^(?:ST-|HS-)?([0-9][A-Z0-9]*)[-_]?(\d+)$/i);
  if (legacyMatch) {
    const cls = legacyMatch[1].toUpperCase();
    const num = parseInt(legacyMatch[2], 10);
    return `${cls}26-27-${num}`;
  }
  if (stt && typeof stt === 'number' && !isNaN(stt) && stt > 0) {
    return `${cleanCls}26-27-${stt}`;
  }
  // Check if clean has ANY trailing number (e.g. "st-temp-7", "user-22", "hs-7")
  const trailingNumMatch = clean.match(/(\d+)(?!.*\d)/);
  if (trailingNumMatch) {
    const num = parseInt(trailingNumMatch[1], 10);
    if (!isNaN(num) && num > 0) {
      return `${cleanCls}26-27-${num}`;
    }
  }
  return clean || `${cleanCls}26-27-1`;
}

/**
 * Phân định loại bản ghi kết quả bài làm: 'exam' (Bài kiểm tra) hoặc 'assignment' (Bài tập rèn luyện)
 * - Nếu sub?.recordType có giá trị 'exam' hoặc 'assignment' thì trả về giá trị đó.
 * - Nếu không có thì suy ra: có examId thì 'exam', có assignmentId thì 'assignment', còn lại trả về 'assignment'.
 * - Dùng optional chaining, không ném lỗi.
 */
export function getRecordType(sub: any): 'exam' | 'assignment' {
  try {
    if (sub?.recordType === 'exam' || sub?.recordType === 'assignment') {
      return sub.recordType;
    }
    if (sub?.examId) {
      return 'exam';
    }
    if (sub?.assignmentId) {
      return 'assignment';
    }
    // Hỗ trợ thêm trường hợp đối tượng lồng hoặc type/title nếu không có id trực tiếp
    if (sub?.exam || sub?.type === 'exam' || sub?.submissionType === 'exam') {
      return 'exam';
    }
    return 'assignment';
  } catch {
    return 'assignment';
  }
}



