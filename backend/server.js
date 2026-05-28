const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

/* =======================
   MYSQL CONNECTION POOL
======================= */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// Database Schema Initialization & Connection Verification
async function initializeDatabase() {
  let conn;
  try {
    conn = await db.getConnection();
    console.log("✅ MySQL Connected. Verifying and creating schema...");

    // 1. Create rooms table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_no VARCHAR(10) PRIMARY KEY,
        capacity INT NOT NULL,
        type VARCHAR(20) NOT NULL,
        status VARCHAR(20) DEFAULT 'Available'
      )
    `);

    // 2. Add columns to students table if they don't exist
    const [studentCols] = await conn.query("SHOW COLUMNS FROM students");
    const studentFields = studentCols.map(c => c.Field);
    if (!studentFields.includes("ph_no")) {
      await conn.query("ALTER TABLE students ADD COLUMN ph_no VARCHAR(20)");
    }
    if (!studentFields.includes("dept")) {
      await conn.query("ALTER TABLE students ADD COLUMN dept VARCHAR(50)");
    }

    // 3. Add columns to users table if they don't exist
    const [userCols] = await conn.query("SHOW COLUMNS FROM users");
    const userFields = userCols.map(c => c.Field);
    if (!userFields.includes("role")) {
      await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'student'");
    }
    if (!userFields.includes("student_id")) {
      await conn.query("ALTER TABLE users ADD COLUMN student_id INT UNIQUE");
      try {
        await conn.query(`
          ALTER TABLE users 
          ADD CONSTRAINT fk_user_student 
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
        `);
      } catch (fkErr) {
        // FK already exists or table setup issue
      }
    }

    // 4. Update attendance table to add method/geofenced columns
    const [attendanceCols] = await conn.query("SHOW COLUMNS FROM attendance");
    const attendanceFields = attendanceCols.map(c => c.Field);
    if (!attendanceFields.includes("method")) {
      await conn.query("ALTER TABLE attendance ADD COLUMN method VARCHAR(20) DEFAULT 'Manual'");
    }
    if (!attendanceFields.includes("geofenced")) {
      await conn.query("ALTER TABLE attendance ADD COLUMN geofenced BOOLEAN DEFAULT FALSE");
    }

    // 5. Create complaints table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        description TEXT NOT NULL,
        date DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'Pending',
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    // 6. Create visitors table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        relation VARCHAR(50) NOT NULL,
        student_id INT NOT NULL,
        entry_time DATETIME NOT NULL,
        exit_time DATETIME,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    // 7. Create fees table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS fees (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        due_date DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'Unpaid',
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    // 8. Create leaves table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS leaves (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        reason TEXT NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'Pending',
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    // 9. Seed default rooms if empty
    const [roomRows] = await conn.query("SELECT COUNT(*) as count FROM rooms");
    if (roomRows[0].count === 0) {
      await conn.query(`
        INSERT INTO rooms (room_no, capacity, type, status) VALUES
        ('101', 2, 'AC', 'Available'),
        ('102', 2, 'AC', 'Available'),
        ('103', 4, 'Non-AC', 'Available'),
        ('201', 1, 'AC', 'Available'),
        ('202', 2, 'Non-AC', 'Available')
      `);
      console.log("🌱 Default rooms seeded");
    }

    console.log("✅ Database schema verified and initialized");
  } catch (err) {
    console.log("❌ DB Initialization Error:", err.message);
  } finally {
    if (conn) conn.release();
  }
}

// Run DB Initializer
initializeDatabase();

// Dynamic PIN store for smart attendance check-in (rotates every 30s)
let activeAttendancePIN = {
  code: "000000",
  generatedAt: 0,
  expiresInSeconds: 30
};

function rotatePIN() {
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  activeAttendancePIN = {
    code: pin,
    generatedAt: Date.now(),
    expiresInSeconds: 30
  };
  return activeAttendancePIN;
}

// Rotate immediately and schedule interval
rotatePIN();
setInterval(rotatePIN, 30000);

/* =======================
   HELPER: Validate fields
======================= */
function validateFields(fields, res) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || String(value).trim() === "") {
      res.status(400).json({ success: false, message: `${key} is required` });
      return false;
    }
  }
  return true;
}

/* =======================
   TEST ROUTE
======================= */
app.get("/", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});

/* =======================
   SIGNUP ROUTE
======================= */
app.post("/signup", async (req, res) => {
  try {
    const { username, password, role, email } = req.body;
    if (!validateFields({ username, password }, res)) return;

    const userRole = role || "student";

    // Check if username already exists
    const [existing] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: "Username already exists" });
    }

    let linkedStudentId = null;

    if (userRole === "student") {
      if (!email) {
        return res.status(400).json({ success: false, message: "Email is required for student registration" });
      }

      // Check if email exists in students pre-registered list
      const [studentRow] = await db.query(
        "SELECT id FROM students WHERE email = ?",
        [email.trim()]
      );

      if (studentRow.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Your email is not pre-registered by the Warden. Please contact support."
        });
      }

      linkedStudentId = studentRow[0].id;

      // Check if student profile is already linked to a user account
      const [existingStudentLink] = await db.query(
        "SELECT id FROM users WHERE student_id = ?",
        [linkedStudentId]
      );

      if (existingStudentLink.length > 0) {
        return res.status(409).json({
          success: false,
          message: "An account has already been registered for this student email."
        });
      }
    }

    // Hash password before storing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const [result] = await db.query(
      "INSERT INTO users (username, password, role, student_id) VALUES (?, ?, ?, ?)",
      [username, hashedPassword, userRole, linkedStudentId]
    );

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: { id: result.insertId, username, role: userRole, student_id: linkedStudentId },
    });
  } catch (err) {
    console.error("Signup Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   LOGIN ROUTE
======================= */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!validateFields({ username, password }, res)) return;

    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    res.json({
      success: true,
      message: "Login successful",
      user: { id: user.id, username: user.username, role: user.role, student_id: user.student_id },
    });
  } catch (err) {
    console.error("Login Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   STUDENTS ROUTE (CRUD)
======================= */
app.post("/students", async (req, res) => {
  try {
    const { name, email, room_no, ph_no, dept } = req.body;
    if (!validateFields({ name, email, room_no }, res)) return;

    const [result] = await db.query(
      "INSERT INTO students (name, email, room_no, ph_no, dept) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), email.trim(), room_no, ph_no ? ph_no.trim() : null, dept ? dept.trim() : null]
    );

    // If a room was specified, verify room capacity status
    if (room_no && room_no !== "Unallocated") {
      const [rooms] = await db.query("SELECT capacity FROM rooms WHERE room_no = ?", [room_no]);
      if (rooms.length > 0) {
        const [occupants] = await db.query("SELECT COUNT(*) AS count FROM students WHERE room_no = ?", [room_no]);
        if (occupants[0].count >= rooms[0].capacity) {
          await db.query("UPDATE rooms SET status = 'Full' WHERE room_no = ?", [room_no]);
        }
      }
    }

    res.status(201).json({
      success: true,
      message: "Student added successfully",
      student: { id: result.insertId, name, email, room_no, ph_no, dept },
    });
  } catch (err) {
    console.error("Add Student Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/students", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, u.id AS user_account_id 
      FROM students s
      LEFT JOIN users u ON s.id = u.student_id
      ORDER BY s.id ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Students Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/students/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query("SELECT * FROM students WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Get Student Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/students/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, room_no, ph_no, dept } = req.body;
    if (!validateFields({ name, email, room_no }, res)) return;

    // Get previous room
    const [oldStudent] = await db.query("SELECT room_no FROM students WHERE id = ?", [id]);
    const oldRoom = oldStudent.length > 0 ? oldStudent[0].room_no : null;

    const [result] = await db.query(
      "UPDATE students SET name = ?, email = ?, room_no = ?, ph_no = ?, dept = ? WHERE id = ?",
      [name.trim(), email.trim(), room_no, ph_no ? ph_no.trim() : null, dept ? dept.trim() : null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    // Refresh rooms capacity status
    if (oldRoom && oldRoom !== "Unallocated") {
      await db.query("UPDATE rooms SET status = 'Available' WHERE room_no = ?", [oldRoom]);
    }
    if (room_no && room_no !== "Unallocated") {
      const [rooms] = await db.query("SELECT capacity FROM rooms WHERE room_no = ?", [room_no]);
      if (rooms.length > 0) {
        const [occupants] = await db.query("SELECT COUNT(*) AS count FROM students WHERE room_no = ?", [room_no]);
        if (occupants[0].count >= rooms[0].capacity) {
          await db.query("UPDATE rooms SET status = 'Full' WHERE room_no = ?", [room_no]);
        } else {
          await db.query("UPDATE rooms SET status = 'Available' WHERE room_no = ?", [room_no]);
        }
      }
    }

    res.json({ success: true, message: "Student updated successfully" });
  } catch (err) {
    console.error("Update Student Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.delete("/students/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Get room before deleting
    const [student] = await db.query("SELECT room_no FROM students WHERE id = ?", [id]);
    const room = student.length > 0 ? student[0].room_no : null;

    const [result] = await db.query("DELETE FROM students WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    // Update room status
    if (room && room !== "Unallocated") {
      await db.query("UPDATE rooms SET status = 'Available' WHERE room_no = ?", [room]);
    }

    res.json({ success: true, message: "Student deleted successfully" });
  } catch (err) {
    console.error("Delete Student Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   ROOMS MANAGEMENT
======================= */
app.get("/rooms", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.room_no, r.capacity, r.type, r.status, COUNT(s.id) AS occupant_count
      FROM rooms r
      LEFT JOIN students s ON r.room_no = s.room_no
      GROUP BY r.room_no, r.capacity, r.type, r.status
      ORDER BY r.room_no ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Rooms Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/rooms", async (req, res) => {
  try {
    const { room_no, capacity, type } = req.body;
    if (!validateFields({ room_no, capacity, type }, res)) return;

    const [existing] = await db.query("SELECT room_no FROM rooms WHERE room_no = ?", [room_no]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: "Room number already exists" });
    }

    await db.query(
      "INSERT INTO rooms (room_no, capacity, type, status) VALUES (?, ?, ?, 'Available')",
      [room_no.trim(), capacity, type.trim()]
    );

    res.status(201).json({ success: true, message: "Room added successfully" });
  } catch (err) {
    console.error("Add Room Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.delete("/rooms/:room_no", async (req, res) => {
  try {
    const { room_no } = req.params;

    const [occupants] = await db.query("SELECT id FROM students WHERE room_no = ?", [room_no]);
    if (occupants.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete room. It still has students allocated."
      });
    }

    const [result] = await db.query("DELETE FROM rooms WHERE room_no = ?", [room_no]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Room not found" });
    }

    res.json({ success: true, message: "Room deleted successfully" });
  } catch (err) {
    console.error("Delete Room Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/rooms/allocate", async (req, res) => {
  try {
    const { student_id, room_no } = req.body;
    if (!validateFields({ student_id, room_no }, res)) return;

    const [rooms] = await db.query("SELECT capacity, status FROM rooms WHERE room_no = ?", [room_no]);
    if (rooms.length === 0) {
      return res.status(404).json({ success: false, message: "Room not found" });
    }

    const room = rooms[0];
    const [occupants] = await db.query("SELECT COUNT(*) AS count FROM students WHERE room_no = ?", [room_no]);
    const currentCount = occupants[0].count;

    if (currentCount >= room.capacity) {
      return res.status(400).json({ success: false, message: "Room is already at full capacity" });
    }

    await db.query("UPDATE students SET room_no = ? WHERE id = ?", [room_no, student_id]);

    if (currentCount + 1 >= room.capacity) {
      await db.query("UPDATE rooms SET status = 'Full' WHERE room_no = ?", [room_no]);
    } else {
      await db.query("UPDATE rooms SET status = 'Available' WHERE room_no = ?", [room_no]);
    }

    res.json({ success: true, message: "Room allocated successfully" });
  } catch (err) {
    console.error("Allocate Room Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/rooms/deallocate", async (req, res) => {
  try {
    const { student_id } = req.body;
    if (!validateFields({ student_id }, res)) return;

    const [students] = await db.query("SELECT room_no FROM students WHERE id = ?", [student_id]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    const currentRoom = students[0].room_no;

    if (currentRoom) {
      await db.query("UPDATE students SET room_no = 'Unallocated' WHERE id = ?", [student_id]);
      await db.query("UPDATE rooms SET status = 'Available' WHERE room_no = ?", [currentRoom]);
    }

    res.json({ success: true, message: "Room deallocated successfully" });
  } catch (err) {
    console.error("Deallocate Room Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   COMPLAINTS MANAGEMENT
======================= */
app.get("/complaints", async (req, res) => {
  try {
    const { student_id } = req.query;
    let query = `
      SELECT c.id, c.student_id, s.name AS student_name, s.room_no, c.description, c.date, c.status
      FROM complaints c
      JOIN students s ON c.student_id = s.id
    `;
    let params = [];

    if (student_id) {
      query += " WHERE c.student_id = ?";
      params.push(student_id);
    }

    query += " ORDER BY c.date DESC, c.id DESC";

    const [rows] = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Complaints Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/complaints", async (req, res) => {
  try {
    const { student_id, description } = req.body;
    if (!validateFields({ student_id, description }, res)) return;

    const date = new Date().toISOString().split("T")[0];

    await db.query(
      "INSERT INTO complaints (student_id, description, date, status) VALUES (?, ?, ?, 'Pending')",
      [student_id, description.trim(), date]
    );

    res.status(201).json({ success: true, message: "Complaint filed successfully" });
  } catch (err) {
    console.error("File Complaint Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/complaints/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!validateFields({ status }, res)) return;

    const [result] = await db.query(
      "UPDATE complaints SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Complaint not found" });
    }

    res.json({ success: true, message: "Complaint status updated" });
  } catch (err) {
    console.error("Update Complaint Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   VISITORS TRACKING
======================= */
app.get("/visitors", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT v.id, v.name, v.relation, v.student_id, s.name AS student_name, s.room_no, v.entry_time, v.exit_time
      FROM visitors v
      JOIN students s ON v.student_id = s.id
      ORDER BY v.entry_time DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Visitors Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/visitors", async (req, res) => {
  try {
    const { name, relation, student_id } = req.body;
    if (!validateFields({ name, relation, student_id }, res)) return;

    const entryTime = new Date();

    await db.query(
      "INSERT INTO visitors (name, relation, student_id, entry_time) VALUES (?, ?, ?, ?)",
      [name.trim(), relation.trim(), student_id, entryTime]
    );

    res.status(201).json({ success: true, message: "Visitor logged in successfully" });
  } catch (err) {
    console.error("Log Visitor Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/visitors/:id/exit", async (req, res) => {
  try {
    const { id } = req.params;
    const exitTime = new Date();

    const [result] = await db.query(
      "UPDATE visitors SET exit_time = ? WHERE id = ? AND exit_time IS NULL",
      [exitTime, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Visitor already exited or not found" });
    }

    res.json({ success: true, message: "Visitor exit logged" });
  } catch (err) {
    console.error("Exit Visitor Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   FEES MANAGEMENT
======================= */
app.get("/fees", async (req, res) => {
  try {
    const { student_id } = req.query;
    let query = `
      SELECT f.id, f.student_id, s.name AS student_name, s.room_no, f.amount, f.due_date, f.status
      FROM fees f
      JOIN students s ON f.student_id = s.id
    `;
    let params = [];

    if (student_id) {
      query += " WHERE f.student_id = ?";
      params.push(student_id);
    }

    query += " ORDER BY f.due_date DESC";

    const [rows] = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Fees Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/fees", async (req, res) => {
  try {
    const { student_id, amount, due_date, target } = req.body;
    if (!validateFields({ amount, due_date }, res)) return;

    if (target === "all") {
      const [students] = await db.query("SELECT id FROM students");
      if (students.length === 0) {
        return res.status(400).json({ success: false, message: "No students registered to bill" });
      }

      const values = students.map(s => [s.id, amount, due_date, "Unpaid"]);
      await db.query(
        "INSERT INTO fees (student_id, amount, due_date, status) VALUES ?",
        [values]
      );
    } else {
      if (!student_id) {
        return res.status(400).json({ success: false, message: "student_id is required for single billing" });
      }
      await db.query(
        "INSERT INTO fees (student_id, amount, due_date, status) VALUES (?, ?, ?, 'Unpaid')",
        [student_id, amount, due_date]
      );
    }

    res.status(201).json({ success: true, message: "Fee bill issued successfully" });
  } catch (err) {
    console.error("Issue Fee Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/fees/:id/pay", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      "UPDATE fees SET status = 'Paid' WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Fee record not found" });
    }

    res.json({ success: true, message: "Fee payment recorded successfully" });
  } catch (err) {
    console.error("Pay Fee Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   LEAVE APPLICATIONS
======================= */
app.get("/leaves", async (req, res) => {
  try {
    const { student_id } = req.query;
    let query = `
      SELECT l.id, l.student_id, s.name AS student_name, s.room_no, l.reason, l.from_date, l.to_date, l.status
      FROM leaves l
      JOIN students s ON l.student_id = s.id
    `;
    let params = [];

    if (student_id) {
      query += " WHERE l.student_id = ?";
      params.push(student_id);
    }

    query += " ORDER BY l.from_date DESC";

    const [rows] = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Leaves Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/leaves", async (req, res) => {
  try {
    const { student_id, reason, from_date, to_date } = req.body;
    if (!validateFields({ student_id, reason, from_date, to_date }, res)) return;

    await db.query(
      "INSERT INTO leaves (student_id, reason, from_date, to_date, status) VALUES (?, ?, ?, ?, 'Pending')",
      [student_id, reason.trim(), from_date, to_date]
    );

    res.status(201).json({ success: true, message: "Leave application submitted" });
  } catch (err) {
    console.error("Apply Leave Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/leaves/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!validateFields({ status }, res)) return;

    const [result] = await db.query(
      "UPDATE leaves SET status = ? WHERE id = ?",
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Leave record not found" });
    }

    res.json({ success: true, message: "Leave application status updated" });
  } catch (err) {
    console.error("Update Leave Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   MARK MANUAL ATTENDANCE
======================= */
app.post("/attendance", async (req, res) => {
  try {
    const { student_id, status } = req.body;
    if (!validateFields({ student_id, status }, res)) return;

    const validStatuses = ["Present", "Absent"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be 'Present' or 'Absent'" });
    }

    const date = new Date().toISOString().split("T")[0];

    // Check if attendance already marked for today
    const [existing] = await db.query(
      "SELECT id FROM attendance WHERE student_id = ? AND date = ?",
      [student_id, date]
    );

    if (existing.length > 0) {
      await db.query(
        "UPDATE attendance SET status = ?, method = 'Manual Override' WHERE student_id = ? AND date = ?",
        [status, student_id, date]
      );
      return res.json({ success: true, message: "Attendance updated successfully" });
    }

    await db.query(
      "INSERT INTO attendance (student_id, date, status, method) VALUES (?, ?, ?, 'Manual')",
      [student_id, date, status]
    );

    res.status(201).json({ success: true, message: "Attendance marked successfully" });
  } catch (err) {
    console.error("Mark Attendance Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/attendance", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT a.id, a.student_id, s.name AS student_name, s.room_no, a.date, a.status, a.method, a.geofenced
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      ORDER BY a.date DESC, s.name ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Attendance Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/attendance/:student_id", async (req, res) => {
  try {
    const { student_id } = req.params;

    const [rows] = await db.query(`
      SELECT a.id, a.student_id, s.name AS student_name, a.date, a.status, a.method, a.geofenced
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      WHERE a.student_id = ?
      ORDER BY a.date DESC
    `, [student_id]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Get Student Attendance Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   SMART ATTENDANCE VERIFICATION
======================= */
app.get("/attendance/active-pin", (req, res) => {
  const elapsed = Math.floor((Date.now() - activeAttendancePIN.generatedAt) / 1000);
  const remaining = Math.max(0, 30 - elapsed);
  
  res.json({
    success: true,
    code: activeAttendancePIN.code,
    secondsRemaining: remaining
  });
});

app.post("/attendance/checkin", async (req, res) => {
  try {
    const { student_id, pin, lat, lng, bypass_geofence, bypass_time } = req.body;
    if (!validateFields({ student_id, pin }, res)) return;

    // Validate PIN
    if (String(pin).trim() !== activeAttendancePIN.code) {
      return res.status(400).json({ success: false, message: "Invalid or expired check-in PIN" });
    }

    // Time window constraint: 7:30 PM - 9:00 PM local time
    if (!bypass_time) {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMin = now.getMinutes();
      const checkinTime = currentHour * 60 + currentMin;

      const startTime = 19 * 60 + 30; // 7:30 PM
      const endTime = 21 * 60;        // 9:00 PM

      if (checkinTime < startTime || checkinTime > endTime) {
        return res.status(400).json({
          success: false,
          message: "Check-in is only allowed during the official hours: 7:30 PM - 9:00 PM"
        });
      }
    }

    // Geolocation verification (hostel coords e.g., Bangalore center)
    let isGeofenced = false;
    if (!bypass_geofence) {
      if (lat === undefined || lng === undefined) {
        return res.status(400).json({
          success: false,
          message: "Location access is required to verify physical presence inside the hostel"
        });
      }

      const hostelLat = 12.9716;
      const hostelLng = 77.5946;
      
      const R = 6371e3; // Earth radius in meters
      const phi1 = lat * Math.PI/180;
      const phi2 = hostelLat * Math.PI/180;
      const deltaPhi = (hostelLat-lat) * Math.PI/180;
      const deltaLambda = (hostelLng-lng) * Math.PI/180;

      const a = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) +
                Math.cos(phi1) * Math.cos(phi2) *
                Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c; // in meters

      if (distance > 100) {
        return res.status(400).json({
          success: false,
          message: `Location check failed. You are ${Math.round(distance)}m away from the hostel. Must be within 100m.`
        });
      }
      isGeofenced = true;
    }

    const date = new Date().toISOString().split("T")[0];

    const [existing] = await db.query(
      "SELECT id FROM attendance WHERE student_id = ? AND date = ?",
      [student_id, date]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: "You have already marked your attendance for today" });
    }

    await db.query(
      "INSERT INTO attendance (student_id, date, status, method, geofenced) VALUES (?, ?, 'Present', 'Smart Phone', ?)",
      [student_id, date, isGeofenced ? 1 : 0]
    );

    res.status(201).json({ success: true, message: "Attendance marked present successfully!" });
  } catch (err) {
    console.error("Checkin Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/attendance/report", async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!validateFields({ month, year }, res)) return;

    const numDays = new Date(year, month, 0).getDate();
    const [students] = await db.query("SELECT id, name, room_no FROM students ORDER BY name ASC");

    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDate = `${year}-${String(month).padStart(2, "0")}-${String(numDays).padStart(2, "0")}`;

    const [attendance] = await db.query(`
      SELECT student_id, date, status
      FROM attendance
      WHERE date >= ? AND date <= ?
    `, [startDate, endDate]);

    const recordsMap = {};
    attendance.forEach(r => {
      const sId = r.student_id;
      // Get the correct day representation locally
      const day = new Date(r.date).getDate();
      if (!recordsMap[sId]) recordsMap[sId] = {};
      recordsMap[sId][day] = r.status === "Present" ? "P" : "A";
    });

    res.json({
      success: true,
      numDays,
      students: students.map(s => ({
        id: s.id,
        name: s.name,
        room_no: s.room_no,
        days: recordsMap[s.id] || {}
      }))
    });
  } catch (err) {
    console.error("Report Error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});