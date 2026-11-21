# Security Specification for KHỐI 5 HỌC CÙNG AI

## 1. Data Invariants & Access Model
- **Authentication Gate**: All Firestore reads and writes require a valid Firebase Auth session (`request.auth != null`), including Google Sign-In, teacher email accounts, and student/app `signInAnonymously(auth)` sessions. Unauthenticated requests are denied.
- **Default Deny**: Any path not explicitly matched in `firestore.rules` is denied (`match /{document=**} { allow read, write: if false; }`).
- **Admin Privilege (`isVerifiedAdmin`)**: Requires `request.auth != null`, `request.auth.token.email_verified == true`, and either a bootstrapped admin email or `users/{uid}.role == 'admin'`.
- **Path & Payload Hardening**:
  - Every single-document `get`, `create`, `update`, `delete` validates `isValidId(docId)` (`1..128` chars matching `^[a-zA-Z0-9_.-]+$`).
  - Every `create` and `update` validates payload map size (`<= 100` keys) and field type/length constraints via dedicated `isValid*` helper functions to prevent Denial-of-Wallet and type-poisoning attacks.
- **Covered Collections**:
  - Class & Student Data: `classes`, `class_rosters`, `students`, `student_enrollments`, `student_year_end_results`, `score_records`
  - Teacher & Config Data: `users`, `teachers`, `teacher_groups`, `departments`, `to_chuyen_mon`, `system_settings`, `settings`, `_system_check_`
  - Question Bank, Lessons, Exams & Submissions: `questions`, `lessons`, `lessonPlans`, `elearning_lessons`, `assigned_elearning`, `elearning_student_progress`, `exams`, `exams/{examId}/submissions`, `exam_drafts`, `exam_progress`, `assignments`, `assignments/{assignmentId}/submissions`, `homeworkAssignments`, `submissions`, `deleted_submissions_backup`, `student_results`, `student_results/{studentCode}/exams`, `student_results/{studentCode}/assignments`
  - Games, Live Quiz, Notifications & Logs: `games`, `quizzi_games`, `quiz_live_sessions`, `notifications`, `activities`

## 2. Security Test Invariants
1. Block unauthenticated reads and writes (`request.auth == null`).
2. Block invalid document IDs containing slashes, whitespace, control chars, or length > 128.
3. Reject non-map payloads or oversized maps (> 100 top-level fields).
4. Enforce `isValidQuestion` string/array bounds on `questions` create and update.
5. Enforce `isValidClassRoster` bounds (`students` list <= 120, valid `className`/`classKey`) on `class_rosters` create and update.
6. Prevent non-admin users from escalating their `users/{userId}` `role` to `'admin'` unless verified admin.
7. Restrict PII/account writes on `users/{userId}` to the account owner (`request.auth.uid == userId`) or `isVerifiedAdmin()`.
8. Restrict `system_settings` / `settings` mutations to authenticated sessions with bounded fields (`isVerifiedAdmin()` for global admin configs if verified, or authenticated config updates with strict bounds).
9. Enforce bounded string lengths across titles, descriptions, contents, and codes.
10. Require valid submission payloads across `submissions`, `exams/.../submissions`, and `assignments/.../submissions`.
11. Prevent invalid `status` enum values on `student_year_end_results`.
12. Ensure default-deny for all undefined paths.
