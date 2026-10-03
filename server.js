// server.js - Student Information System backend.
// Built only with Node.js built-in modules (http, fs, path, crypto, node:sqlite).
// Run with:  npm start   then open  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 7;
const EXAM_TYPES = ['Internal 1', 'Internal 2', 'Final'];
const ROLES = ['student', 'faculty', 'admin'];

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function fail(status, message) {
  throw new HttpError(status, message);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function niceName(field) {
  const text = field.replace(/_id$/, '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function required(body, fields) {
  for (const f of fields) {
    const v = body[f];
    if (v === undefined || v === null || String(v).trim() === '') fail(400, `${niceName(f)} is required.`);
  }
}
function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function checkEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
}
function checkPassword(pw) {
  if (String(pw).length < 6) fail(400, 'Password must be at least 6 characters.');
}
function intInRange(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}
function optionalDepartment(id) {
  if (id === undefined || id === null || id === '') return null;
  const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(Number(id));
  if (!dept) fail(400, 'Selected department does not exist.');
  return dept.id;
}
function checkDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) fail(400, 'Choose a valid date.');
  return date;
}
function notify(userId, message) {
  if (userId) db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)').run(userId, message);
}
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Grade scale (10-point scale): percentage -> [letter grade, grade points]
function gradeFor(percent) {
  if (percent >= 91) return ['O', 10];
  if (percent >= 81) return ['A+', 9];
  if (percent >= 71) return ['A', 8];
  if (percent >= 61) return ['B+', 7];
  if (percent >= 56) return ['B', 6];
  if (percent >= 50) return ['C', 5];
  return ['U', 0];
}

// Builds a student's results from the marks faculty have actually entered.
function studentResults(studentId) {
  const rows = db.prepare(`
    SELECT c.id, c.code, c.name, c.credits, g.exam_type, g.marks
    FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN grades g ON g.course_id = c.id AND g.student_id = e.student_id
    WHERE e.student_id = ? AND e.status = 'approved'
    ORDER BY c.code`).all(studentId);

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) map.set(r.id, { id: r.id, code: r.code, name: r.name, credits: r.credits, marks: {} });
    if (r.exam_type) map.get(r.id).marks[r.exam_type] = r.marks;
  }

  let points = 0;
  let credits = 0;
  const courses = [...map.values()].map((c) => {
    const values = Object.values(c.marks);
    if (values.length === 0) return { ...c, average: null, grade: null, result: null };
    const average = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    const [grade, gp] = gradeFor(average);
    points += gp * c.credits;
    credits += c.credits;
    return { ...c, average, grade, result: gp > 0 ? 'Pass' : 'Fail' };
  });
  const cgpa = credits > 0 ? Math.round((points / credits) * 100) / 100 : null;
  return { courses, cgpa, examTypes: EXAM_TYPES };
}

// ---------------------------------------------------------------- sessions

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function currentUser(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now()) || null;
}

// ---------------------------------------------------------------- router

const routes = [];
// roles: null = public, 'any' = any logged-in user, or an array like ['admin']
function route(method, pattern, roles, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, regex, keys, roles, handler });
}

// ================================================================ PUBLIC / AUTH

// Anyone can create an account and choose their role: student, faculty or admin.
route('POST', '/api/register', null, ({ body, res }) => {
  required(body, ['role', 'name', 'email', 'password']);
  if (!ROLES.includes(body.role)) fail(400, 'Choose a valid role.');
  const email = String(body.email).trim().toLowerCase();
  checkEmail(email);
  checkPassword(body.password);
  const deptId = optionalDepartment(body.department_id);
  const isStudent = body.role === 'student';
  const r = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, phone, dob, program, department_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(body.name).trim(), email, hashPassword(String(body.password)), body.role,
      clean(body.phone), isStudent ? clean(body.dob) : null, isStudent ? clean(body.program) : null, deptId);
  createSession(res, Number(r.lastInsertRowid));
  return { role: body.role };
});

route('POST', '/api/login', null, ({ body, res }) => {
  required(body, ['email', 'password']);
  const user = db.prepare('SELECT id, role, password_hash FROM users WHERE email = ?')
    .get(String(body.email).trim().toLowerCase());
  if (!user || !verifyPassword(String(body.password), user.password_hash)) {
    fail(400, 'Email or password is incorrect.');
  }
  createSession(res, user.id);
  return { role: user.role };
});

route('POST', '/api/logout', 'any', ({ req, res }) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(getCookie(req, 'sid'));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', 'any', ({ user }) => {
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).n;
  return { ...user, unread };
});

// Used by the login page to check if someone is already logged in (returns null when not).
route('GET', '/api/session', null, ({ user }) => ({ user }));

route('GET', '/api/departments', null, () =>
  db.prepare('SELECT id, name FROM departments ORDER BY name').all());

route('GET', '/api/notifications', 'any', ({ user }) =>
  db.prepare('SELECT id, message, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(user.id));

route('POST', '/api/notifications/read-all', 'any', ({ user }) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
  return { ok: true };
});

// ================================================================ STUDENT

const STUDENT = ['student'];

route('GET', '/api/student/profile', STUDENT, ({ user }) =>
  db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.dob, u.address, u.program, u.department_id, d.name AS department, u.created_at
    FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`).get(user.id));

route('PUT', '/api/student/profile', STUDENT, ({ user, body }) => {
  required(body, ['name']);
  const deptId = optionalDepartment(body.department_id);
  db.prepare('UPDATE users SET name = ?, phone = ?, dob = ?, address = ?, program = ?, department_id = ? WHERE id = ?')
    .run(String(body.name).trim(), clean(body.phone), clean(body.dob), clean(body.address), clean(body.program), deptId, user.id);
  return { ok: true };
});

route('GET', '/api/student/dashboard', STUDENT, ({ user }) => {
  const approved = db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ? AND status = 'approved'").get(user.id).n;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ? AND status = 'pending'").get(user.id).n;
  const att = db.prepare(`
    SELECT COUNT(a.id) AS total, COALESCE(SUM(a.status = 'present'), 0) AS present
    FROM attendance a
    JOIN enrollments e ON e.course_id = a.course_id AND e.student_id = a.student_id AND e.status = 'approved'
    WHERE a.student_id = ?`).get(user.id);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).n;
  return {
    approved,
    pending,
    attendancePercent: att.total > 0 ? Math.round((att.present * 100) / att.total) : null,
    cgpa: studentResults(user.id).cgpa,
    unread,
  };
});

route('GET', '/api/student/courses', STUDENT, ({ user }) =>
  db.prepare(`
    SELECT c.id, c.code, c.name, c.credits, c.semester, d.name AS department, f.name AS faculty,
           e.id AS enrollment_id, e.status
    FROM courses c
    LEFT JOIN departments d ON d.id = c.department_id
    LEFT JOIN users f ON f.id = c.faculty_id
    LEFT JOIN enrollments e ON e.course_id = c.id AND e.student_id = ?
    ORDER BY c.semester, c.code`).all(user.id));

route('GET', '/api/student/enrollments', STUDENT, ({ user }) =>
  db.prepare(`
    SELECT e.id, e.status, e.enrolled_at, c.code, c.name, c.credits, c.semester, f.name AS faculty
    FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN users f ON f.id = c.faculty_id
    WHERE e.student_id = ?
    ORDER BY e.id DESC`).all(user.id));

route('POST', '/api/student/enrollments', STUDENT, ({ user, body }) => {
  required(body, ['course_id']);
  const course = db.prepare('SELECT id, code, name, faculty_id FROM courses WHERE id = ?').get(Number(body.course_id));
  if (!course) fail(404, 'Course not found.');
  if (!course.faculty_id) fail(400, 'This course has no faculty assigned yet, so enrollment is not open.');

  const existing = db.prepare('SELECT id, status FROM enrollments WHERE student_id = ? AND course_id = ?').get(user.id, course.id);
  if (existing && existing.status !== 'rejected') fail(409, `You have already requested ${course.code}.`);
  if (existing) {
    db.prepare("UPDATE enrollments SET status = 'pending', enrolled_at = datetime('now') WHERE id = ?").run(existing.id);
  } else {
    db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)').run(user.id, course.id);
  }
  notify(course.faculty_id, `${user.name} requested to enroll in ${course.code} - ${course.name}.`);
  return { ok: true, message: `Enrollment request sent for ${course.code}.` };
});

route('DELETE', '/api/student/enrollments/:id', STUDENT, ({ user, params }) => {
  const e = db.prepare(`
    SELECT e.id, c.code, c.faculty_id FROM enrollments e JOIN courses c ON c.id = e.course_id
    WHERE e.id = ? AND e.student_id = ?`).get(params.id, user.id);
  if (!e) fail(404, 'Enrollment not found.');
  db.prepare('DELETE FROM enrollments WHERE id = ?').run(e.id);
  notify(e.faculty_id, `${user.name} dropped ${e.code}.`);
  return { ok: true, message: `You dropped ${e.code}.` };
});

route('GET', '/api/student/records', STUDENT, ({ user }) => {
  const attendance = db.prepare(`
    SELECT c.id, c.code, c.name, COUNT(a.id) AS total, COALESCE(SUM(a.status = 'present'), 0) AS present
    FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN attendance a ON a.course_id = c.id AND a.student_id = e.student_id
    WHERE e.student_id = ? AND e.status = 'approved'
    GROUP BY c.id ORDER BY c.code`).all(user.id);
  return { attendance, results: studentResults(user.id) };
});

// ================================================================ FACULTY

const FACULTY = ['faculty'];

function ownCourse(courseId, facultyId) {
  const c = db.prepare('SELECT id, code, name FROM courses WHERE id = ? AND faculty_id = ?').get(courseId, facultyId);
  if (!c) fail(404, 'Course not found or not assigned to you.');
  return c;
}
function approvedStudentIds(courseId) {
  return new Set(db.prepare("SELECT student_id FROM enrollments WHERE course_id = ? AND status = 'approved'")
    .all(courseId).map((r) => r.student_id));
}

route('GET', '/api/faculty/dashboard', FACULTY, ({ user }) => {
  const courses = db.prepare(`
    SELECT c.id, c.code, c.name, c.semester, c.credits,
           COALESCE(SUM(e.status = 'approved'), 0) AS approved,
           COALESCE(SUM(e.status = 'pending'), 0) AS pending
    FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id
    WHERE c.faculty_id = ? GROUP BY c.id ORDER BY c.code`).all(user.id);
  const requests = db.prepare(`
    SELECT e.id, e.enrolled_at, u.name AS student, u.email, u.program, c.code, c.name AS course
    FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN users u ON u.id = e.student_id
    WHERE c.faculty_id = ? AND e.status = 'pending' ORDER BY e.enrolled_at`).all(user.id);
  return { courses, requests };
});

function decide(user, id, status) {
  const e = db.prepare(`
    SELECT e.id, e.student_id, c.code, c.name FROM enrollments e JOIN courses c ON c.id = e.course_id
    WHERE e.id = ? AND c.faculty_id = ?`).get(id, user.id);
  if (!e) fail(404, 'Enrollment request not found.');
  db.prepare('UPDATE enrollments SET status = ? WHERE id = ?').run(status, e.id);
  notify(e.student_id, `Your enrollment in ${e.code} - ${e.name} was ${status}.`);
  return { ok: true, message: `Request ${status}.` };
}
route('POST', '/api/faculty/enrollments/:id/approve', FACULTY, ({ user, params }) => decide(user, params.id, 'approved'));
route('POST', '/api/faculty/enrollments/:id/reject', FACULTY, ({ user, params }) => decide(user, params.id, 'rejected'));

route('GET', '/api/faculty/courses', FACULTY, ({ user }) =>
  db.prepare('SELECT id, code, name FROM courses WHERE faculty_id = ? ORDER BY code').all(user.id));

route('GET', '/api/faculty/courses/:id/students', FACULTY, ({ user, params }) => {
  ownCourse(params.id, user.id);
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.program FROM enrollments e JOIN users u ON u.id = e.student_id
    WHERE e.course_id = ? AND e.status = 'approved' ORDER BY u.name`).all(params.id);
});

route('GET', '/api/faculty/courses/:id/attendance', FACULTY, ({ user, params, query }) => {
  ownCourse(params.id, user.id);
  const date = checkDate(query.get('date'));
  return db.prepare(`
    SELECT u.id, u.name, u.email, a.status
    FROM enrollments e
    JOIN users u ON u.id = e.student_id
    LEFT JOIN attendance a ON a.course_id = e.course_id AND a.student_id = u.id AND a.date = ?
    WHERE e.course_id = ? AND e.status = 'approved' ORDER BY u.name`).all(date, params.id);
});

route('POST', '/api/faculty/courses/:id/attendance', FACULTY, ({ user, params, body }) => {
  const course = ownCourse(params.id, user.id);
  const date = checkDate(body.date);
  if (!Array.isArray(body.records) || body.records.length === 0) fail(400, 'There are no students to save attendance for.');
  const allowed = approvedStudentIds(course.id);
  const stmt = db.prepare(`
    INSERT INTO attendance (course_id, student_id, date, status) VALUES (?, ?, ?, ?)
    ON CONFLICT (course_id, student_id, date) DO UPDATE SET status = excluded.status`);
  transaction(() => {
    for (const r of body.records) {
      const sid = Number(r.student_id);
      if (!allowed.has(sid)) fail(400, 'One of the students is not enrolled in this course.');
      if (!['present', 'absent'].includes(r.status)) fail(400, 'Attendance must be present or absent.');
      stmt.run(course.id, sid, date, r.status);
    }
  });
  return { ok: true, message: `Attendance saved for ${course.code} on ${date}.` };
});

route('GET', '/api/faculty/courses/:id/grades', FACULTY, ({ user, params, query }) => {
  ownCourse(params.id, user.id);
  const exam = query.get('exam');
  if (!EXAM_TYPES.includes(exam)) fail(400, 'Choose a valid exam type.');
  return db.prepare(`
    SELECT u.id, u.name, u.email, g.marks
    FROM enrollments e
    JOIN users u ON u.id = e.student_id
    LEFT JOIN grades g ON g.course_id = e.course_id AND g.student_id = u.id AND g.exam_type = ?
    WHERE e.course_id = ? AND e.status = 'approved' ORDER BY u.name`).all(exam, params.id);
});

route('POST', '/api/faculty/courses/:id/grades', FACULTY, ({ user, params, body }) => {
  const course = ownCourse(params.id, user.id);
  if (!EXAM_TYPES.includes(body.exam_type)) fail(400, 'Choose a valid exam type.');
  if (!Array.isArray(body.records) || body.records.length === 0) fail(400, 'There are no students to save marks for.');
  const allowed = approvedStudentIds(course.id);
  const upsert = db.prepare(`
    INSERT INTO grades (course_id, student_id, exam_type, marks) VALUES (?, ?, ?, ?)
    ON CONFLICT (course_id, student_id, exam_type) DO UPDATE SET marks = excluded.marks, updated_at = datetime('now')`);
  const remove = db.prepare('DELETE FROM grades WHERE course_id = ? AND student_id = ? AND exam_type = ?');
  let saved = 0;
  transaction(() => {
    for (const r of body.records) {
      const sid = Number(r.student_id);
      if (!allowed.has(sid)) fail(400, 'One of the students is not enrolled in this course.');
      if (r.marks === '' || r.marks === null || r.marks === undefined) {
        remove.run(course.id, sid, body.exam_type);
        continue;
      }
      const marks = Number(r.marks);
      if (Number.isNaN(marks) || marks < 0 || marks > 100) fail(400, 'Marks must be between 0 and 100.');
      upsert.run(course.id, sid, body.exam_type, marks);
      notify(sid, `Your ${body.exam_type} marks for ${course.code} have been updated.`);
      saved++;
    }
  });
  return { ok: true, message: `Saved ${body.exam_type} marks for ${saved} student(s) in ${course.code}.` };
});

// ================================================================ ADMIN

const ADMIN = ['admin'];

route('GET', '/api/admin/dashboard', ADMIN, () => {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    students: n("SELECT COUNT(*) AS n FROM users WHERE role = 'student'"),
    faculty: n("SELECT COUNT(*) AS n FROM users WHERE role = 'faculty'"),
    departments: n('SELECT COUNT(*) AS n FROM departments'),
    courses: n('SELECT COUNT(*) AS n FROM courses'),
    pending: n("SELECT COUNT(*) AS n FROM enrollments WHERE status = 'pending'"),
    recent: db.prepare(`
      SELECT e.status, e.enrolled_at, u.name AS student, c.code, c.name AS course
      FROM enrollments e JOIN users u ON u.id = e.student_id JOIN courses c ON c.id = e.course_id
      ORDER BY e.id DESC LIMIT 8`).all(),
  };
});

// --- users
route('GET', '/api/admin/users', ADMIN, ({ query }) => {
  const role = query.get('role');
  if (!ROLES.includes(role)) fail(400, 'Unknown role.');
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.program, d.name AS department, u.created_at
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role = ? ORDER BY u.name`).all(role);
});

route('POST', '/api/admin/users', ADMIN, ({ body }) => {
  required(body, ['name', 'email', 'password', 'role']);
  if (!ROLES.includes(body.role)) fail(400, 'Unknown role.');
  const email = String(body.email).trim().toLowerCase();
  checkEmail(email);
  checkPassword(body.password);
  const deptId = optionalDepartment(body.department_id);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, phone, program, department_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(String(body.name).trim(), email, hashPassword(String(body.password)), body.role,
      clean(body.phone), clean(body.program), deptId);
  return { ok: true, message: `${niceName(body.role)} account created for ${email}.` };
});

route('DELETE', '/api/admin/users/:id', ADMIN, ({ user, params }) => {
  if (params.id === user.id) fail(400, 'You cannot delete your own account.');
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(params.id);
  if (r.changes === 0) fail(404, 'User not found.');
  return { ok: true, message: 'User deleted.' };
});

// --- departments
route('GET', '/api/admin/departments', ADMIN, () =>
  db.prepare(`
    SELECT d.id, d.name, d.hod,
      (SELECT COUNT(*) FROM courses c WHERE c.department_id = d.id) AS courses,
      (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.role = 'student') AS students
    FROM departments d ORDER BY d.name`).all());

route('POST', '/api/admin/departments', ADMIN, ({ body }) => {
  required(body, ['name']);
  db.prepare('INSERT INTO departments (name, hod) VALUES (?, ?)').run(String(body.name).trim(), clean(body.hod));
  return { ok: true, message: 'Department added.' };
});

route('PUT', '/api/admin/departments/:id', ADMIN, ({ params, body }) => {
  required(body, ['name']);
  const r = db.prepare('UPDATE departments SET name = ?, hod = ? WHERE id = ?').run(String(body.name).trim(), clean(body.hod), params.id);
  if (r.changes === 0) fail(404, 'Department not found.');
  return { ok: true, message: 'Department updated.' };
});

route('DELETE', '/api/admin/departments/:id', ADMIN, ({ params }) => {
  const r = db.prepare('DELETE FROM departments WHERE id = ?').run(params.id);
  if (r.changes === 0) fail(404, 'Department not found.');
  return { ok: true, message: 'Department deleted.' };
});

// --- courses
function courseFields(body) {
  required(body, ['code', 'name', 'credits', 'semester']);
  const credits = intInRange(body.credits, 1, 10, 'Credits');
  const semester = intInRange(body.semester, 1, 8, 'Semester');
  const deptId = optionalDepartment(body.department_id);
  let facultyId = null;
  if (body.faculty_id) {
    const f = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'faculty'").get(Number(body.faculty_id));
    if (!f) fail(400, 'Selected faculty does not exist.');
    facultyId = f.id;
  }
  return [String(body.code).trim().toUpperCase(), String(body.name).trim(), credits, semester, deptId, facultyId];
}

route('GET', '/api/admin/courses', ADMIN, () =>
  db.prepare(`
    SELECT c.id, c.code, c.name, c.credits, c.semester, c.department_id, c.faculty_id,
           d.name AS department, f.name AS faculty,
           (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id AND e.status = 'approved') AS enrolled
    FROM courses c
    LEFT JOIN departments d ON d.id = c.department_id
    LEFT JOIN users f ON f.id = c.faculty_id
    ORDER BY c.semester, c.code`).all());

route('POST', '/api/admin/courses', ADMIN, ({ body }) => {
  const f = courseFields(body);
  db.prepare('INSERT INTO courses (code, name, credits, semester, department_id, faculty_id) VALUES (?, ?, ?, ?, ?, ?)').run(...f);
  if (f[5]) notify(f[5], `You have been assigned to teach ${f[0]} - ${f[1]}.`);
  return { ok: true, message: `Course ${f[0]} added.` };
});

route('PUT', '/api/admin/courses/:id', ADMIN, ({ params, body }) => {
  const f = courseFields(body);
  const before = db.prepare('SELECT faculty_id FROM courses WHERE id = ?').get(params.id);
  if (!before) fail(404, 'Course not found.');
  db.prepare('UPDATE courses SET code = ?, name = ?, credits = ?, semester = ?, department_id = ?, faculty_id = ? WHERE id = ?')
    .run(...f, params.id);
  if (f[5] && f[5] !== before.faculty_id) notify(f[5], `You have been assigned to teach ${f[0]} - ${f[1]}.`);
  return { ok: true, message: `Course ${f[0]} updated.` };
});

route('DELETE', '/api/admin/courses/:id', ADMIN, ({ params }) => {
  const r = db.prepare('DELETE FROM courses WHERE id = ?').run(params.id);
  if (r.changes === 0) fail(404, 'Course not found.');
  return { ok: true, message: 'Course deleted.' };
});

// ---------------------------------------------------------------- HTTP server

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new HttpError(413, 'Request is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'Invalid request data.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { rel = '/'; }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>Page not found</h1><p><a href="/">Go to the login page</a></p>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

function uniqueMessage(msg) {
  if (msg.includes('users.email')) return 'An account with this email already exists.';
  if (msg.includes('courses.code')) return 'A course with this code already exists.';
  if (msg.includes('departments.name')) return 'A department with this name already exists.';
  return 'This record already exists.';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

  try {
    let match = null;
    let found = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.regex);
      if (m) { match = m; found = r; break; }
    }
    if (!found) fail(404, 'API route not found.');

    const user = currentUser(req);
    if (found.roles !== null) {
      if (!user) fail(401, 'Please log in to continue.');
      if (Array.isArray(found.roles) && !found.roles.includes(user.role)) fail(403, 'You do not have access to this.');
    }

    const params = {};
    found.keys.forEach((k, i) => { params[k] = Number(match[i + 1]); });
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

    const result = await found.handler({ req, res, user, params, body, query: url.searchParams });
    sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    if (String(err.message).includes('UNIQUE constraint failed')) return sendJson(res, 409, { error: uniqueMessage(err.message) });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on the server. Check the terminal for details.' });
  }
});

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

server.listen(PORT, () => {
  console.log('Student Information System is running.');
  console.log(`Open http://localhost:${PORT} in your browser.`);
  console.log('Press Ctrl + C to stop the server.');
});
