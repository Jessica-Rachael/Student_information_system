# Student Information System

A working Student Information System website with three roles:

- **Admin** - adds departments, courses, faculty and other users
- **Faculty** - approves enrollment requests, marks attendance, enters marks
- **Student** - registers, enrolls in courses, views attendance, grades and CGPA

All data is saved in a real SQLite database file (`data/sis.db`). The database starts empty, and nothing is pre-filled.

## Requirements

- Node.js **22.13 or newer** (Node 22 LTS or Node 24 LTS). No `npm install` is needed. The project uses only built-in Node modules.

## Run

```
npm start
```

Then open http://localhost:3000

## First-time use

1. On the login page, click **Create an account**.
2. Choose a role (**Student**, **Faculty** or **Administrator**), fill in the details, and click **Create account**. The dashboard for that role opens.
3. As admin: add departments, then courses (assign a faculty member to each course).
4. As student: open **Courses** and click **Enroll**.
5. As faculty: approve the request on the dashboard, then use **Mark Attendance** and **Enter Grades**.
6. As student again: see attendance, marks, grade and CGPA.

## Reset all data

Stop the server, delete the `data` folder, and run `npm start` again.

## Project structure

| Path | Purpose |
|---|---|
| `server.js` | Web server and all API routes |
| `db.js` | Creates the database and tables |
| `data/sis.db` | Database file (created automatically) |
| `public/` | All web pages, styles and scripts |
