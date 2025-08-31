import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import mysql2 from "mysql2/promise";
import nodemailer from "nodemailer";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
app.use(express.json());

// CORS: allow your frontend origin (set FRONTEND_ORIGIN in env), fallback to *
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: FRONTEND_ORIGIN }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------
// MySQL connection
// ---------------------------
const db = await mysql2.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------------------------
// Nodemailer transporter
// ---------------------------
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn("EMAIL_USER or EMAIL_PASS missing — emails will fail.");
}
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Gmail app password recommended
  },
});

// Link expiry
const LINK_EXPIRY_MS = 3 * 60 * 1000; // 3 minutes

// ---------------------------
// 1) Submit new resume request
// ---------------------------
app.post("/request-resume", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email || !reason) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const [result] = await db.query(
      "INSERT INTO resume_requests (name, email, reason, status, created_at , approved_at) VALUES (?, ?, ?, 'pending', NOW(),NULL)",
      [name, email, reason]
    );

    // Send notification to admin with an "Approve" button/link
    const adminApproveLink = `${process.env.BACKEND_URL || "http://localhost:5000"}/admin-approve/${result.insertId}`;
    const adminHtml = `
      <div style="font-family:Arial,sans-serif">
        <h2>New Resume Request</h2>
        <div style="background:#f1f5f9;padding:12px;border-radius:8px;">
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Reason:</strong> ${reason}</p>
        </div>
        <p style="margin-top:12px">
          <a href="${adminApproveLink}" style="display:inline-block;padding:10px 16px;background:#ff6b6b;color:white;border-radius:6px;text-decoration:none;">Approve Request</a>
        </p>
      </div>
    `;

    if (!process.env.ADMIN_EMAIL) {
      console.warn("ADMIN_EMAIL not set — admin notificaton skipped.");
    } else {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.ADMIN_EMAIL,
        subject: `📬 New Resume Request: ${name}`,
        html: adminHtml,
      });
    }

    res.status(201).json({ message: "Request submitted", id: result.insertId });
  } catch (err) {
    console.error("request-resume error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------------------
// 2) Check request status by email
// ---------------------------
app.get("/request-status/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const [rows] = await db.query("SELECT * FROM resume_requests WHERE email=? ORDER BY id DESC LIMIT 1", [email]);
    if (rows.length === 0) return res.json({ status: "none" });
    return res.json({ status: rows[0].status, id: rows[0].id, approved_at: rows[0].approved_at });
  } catch (err) {
    console.error("request-status error:", err);
    res.status(500).json({ status: "error", message: "Server error" });
  }
});

// ---------------------------
// 3) Approve request (via admin link)
// ---------------------------
app.get("/admin-approve/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const [rows] = await db.query("SELECT * FROM resume_requests WHERE id = ?", [requestId]);
    if (rows.length === 0) return res.status(404).send("Request not found");

    const approvalTime = new Date();
    await db.query("UPDATE resume_requests SET status='approved', approved_at=? WHERE id=?", [approvalTime, requestId]);

    // Send email to user with download link
    const userDownloadLink = `${process.env.BACKEND_URL || "http://localhost:5000"}/download-resume/${requestId}`;
    const userHtml = `
      <div style="font-family:Arial,sans-serif">
        <h2 style="color:#4B6CB7">🎉 Request Approved</h2>
        <div style="background:#f1f5f9;padding:12px;border-radius:8px;">
          <p><strong>Name:</strong> ${rows[0].name}</p>
          <p><strong>Email:</strong> ${rows[0].email}</p>
          <p><strong>Reason:</strong> ${rows[0].reason || "N/A"}</p>
        </div>
        <p style="margin-top:12px">
          <a href="${userDownloadLink}" style="display:inline-block;padding:12px 18px;background:linear-gradient(90deg,#4B6CB7,#182848);color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Download Resume</a>
        </p>
        <p style="font-size:12px;color:#666">Link valid for ${Math.floor(LINK_EXPIRY_MS/60000)} minutes.</p>
      </div>
    `;

    if (rows[0].email) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: rows[0].email,
        subject: "🎉 Your Resume Request is Approved!",
        html: userHtml,
      });
    } else {
      console.warn("No email for request; user notification skipped.");
    }

    // (Optional) Auto-expire: *we don't rely solely on setTimeout for expiry*
    // but we can attempt to mark it expired after LINK_EXPIRY_MS for convenience.
    setTimeout(async () => {
      try {
        // Confirm it's still approved and not already expired/changed
        const [r2] = await db.query("SELECT status FROM resume_requests WHERE id=?", [requestId]);
        if (r2.length && r2[0].status === "approved") {
          await db.query("UPDATE resume_requests SET status='expired' WHERE id=?", [requestId]);
          console.log(`Request ${requestId} auto-expired (set by setTimeout).`);
        }
      } catch (e) {
        console.error("auto-expire error:", e);
      }
    }, LINK_EXPIRY_MS);

    // Friendly admin UI response
    res.send(`<html><body><h3>Request approved.</h3><p>User was notified. Download link valid for ${Math.floor(LINK_EXPIRY_MS/60000)} minutes.</p></body></html>`);
  } catch (err) {
    console.error("admin-approve error:", err);
    res.status(500).send("Server error");
  }
});

// ---------------------------
// 4) Download resume (with expiry check)
// ---------------------------
app.get("/download-resume/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const [rows] = await db.query("SELECT * FROM resume_requests WHERE id=?", [requestId]);
    if (rows.length === 0) return res.status(404).send("Request not found");

    const r = rows[0];
    if (r.status !== "approved") return res.status(403).send("❌ Request not approved.");

    if (!r.approved_at) return res.status(403).send("Approval timestamp missing.");

    const approvedAt = new Date(r.approved_at);
    const now = new Date();
    const diff = now - approvedAt;

    if (diff > LINK_EXPIRY_MS) {
      // mark expired
      await db.query("UPDATE resume_requests SET status='expired', approved_at=NULL WHERE id=?", [requestId]);
      return res.status(403).send("⏳ Your approval has expired. Please request again.");
    }

    // Serve resume file (assuming file placed directly in backend folder)
    const resumePath = path.join(__dirname, "Chakit_Resume.pdf"); // you said file in backend folder
    return res.download(resumePath, "Chakit_Resume.pdf");
  } catch (err) {
    console.error("download-resume error:", err);
    res.status(500).send("Server error");
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
