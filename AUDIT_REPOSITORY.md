# Repository Audit — منصة الامتحانات التعليمية (exammanasa)

**Audit date:** 2026-09-09 · **Repo:** `drmostafatito-alt/exammanasa` · **Audited commit:** `eee3d8f` (`main`), 7 commits total.
**Method:** Full read of every file, static analysis of all code paths, and an offline harness (Node + Google Apps Script service stubs) executing the real `Code.gs` + data files: all 3 validators ran, and **all 73 exams** were opened → answered perfectly → submitted → graded 100% correctly end-to-end. No changes were made to any source file.

---

## 1. Application Architecture

**Type:** Google Apps Script (GAS) Web App — single deployment, two HTML pages, server-rendered data via `google.script.run` (no framework, no build step, no external backend).

```
doGet() ─┬─ /exec                → Index.html  (student UI, Arabic RTL)
         └─ /exec?page=admin     → Admin.html  (teacher dashboard, PIN-protected)
                      (also ?mode=admin / ?admin=1)

Server (Code.gs)
 ├─ Public API (called by students): getAppData, getExam, submitExam, getTeacherImage
 ├─ Admin API (PIN-gated): getTeacherSettings, saveTeacherSettings, getDashboardData,
 │   getAdminOverview, getQuestionBank, getBankFilterOptions, getExamHierarchy,
 │   getPhiloAudit, uploadTeacherImage, deleteTeacherImage, getResultsLink
 ├─ Data: Data.gs / PhiloData.gs / PhiloTerm2Data.gs (const banks, parsed at runtime)
 └─ Storage: Script Properties (settings, secret, spreadsheet id) ·
             Cache Service (exam sessions, 6h TTL) ·
             Google Sheet "النتائج" (auto-created, results log) ·
             Google Drive (teacher photo)
```

**Files (11 tracked, no other files, no .gitignore needed):**

| File | Size | Role |
|---|---|---|
| `Code.gs` | 47 KB / 1,142 lines | All server logic: routing, catalogs, exam sessions (HMAC), grading, results, admin API, settings, social links, image handling, 3 validators |
| `Config.gs` | 243 B | Only `CONFIG_VERSION = '2.0'` |
| `Data.gs` | 726 KB | **Psychology bank — protected, unchanged** (`EXAMS`, `CATALOG`) |
| `PhiloData.gs` | 525 KB | Philosophy & Logic **Term 1** (`PHILO_SUBJECT`, `PHILO_BANK`, `PHILO_EXAMS`, `PHILO_AUDIT`, `PHILO_QUARANTINED`) |
| `PhiloTerm2Data.gs` | 264 KB | Philosophy & Logic **Term 2** (`PHILO_T2_BANK`, `PHILO_T2_EXAMS`, `PHILO_T2_AUDIT`, `PHILO_T2_QUARANTINED`) |
| `Index.html` | 68 KB / 1,309 lines | Student UI (single-page, vanilla JS) |
| `Admin.html` | 68 KB / 1,199 lines | Teacher dashboard (7 tabs) |
| `README.txt` | 10 KB | Full spec/installation doc (Arabic) |
| `AUDIT_PHILOSOPHY.md` / `AUDIT_PHILOSOPHY_TERM2.md` | — | Manual answer-key verification logs |

## 2. Data Inventory (verified by executing the real validators)

### Psychology — الصف الثاني الثانوي (`Data.gs`) — **immutable by design**
- **30 exams / 840 questions.** 6 units × (4 topic exams of 20 Qs + 1 comprehensive of 60 Qs). IDs `U{n}-T{m}` and `U{n}-COMPREHENSIVE`.
- Question fields: `exam_id, unit, topic, question, A, B, C, D, answer, topic_question_no`. Options carry Arabic letter prefixes (`أ) …`) stripped server-side by `stripOptionLabel_()`.
- Answer distribution: B=348, C=295, A=111, D=86.
- Comprehensive exams are unions of the unit's topic exams (by design → 60 Qs).
- **Known & documented defect (intentionally preserved):** `U2-T1` contains 6 duplicated questions (#3=#13, #4=#14, #5=#15, #7=#17, #9=#19, #10=#20), which also propagates 3 duplicates into `U2-COMPREHENSIVE` (#3=#13, #4=#14, #5=#15). README states Data.gs must not be modified to preserve the source.
- `validateSystem()` ✅ passes: 30 exams / 840 Qs, all fields present, all keys A–D, catalog counts match.

### Philosophy & Logic — الصف الأول الثانوي (`PhiloData.gs` = Term 1, `PhiloTerm2Data.gs` = Term 2)
- **Term 1:** 619 Qs = 555 manually verified + 64 authored (`authorCreated`) from the same curriculum. Source: "كتاب الامتحان 2027", 563 source Qs, 8 quarantined, 419 answer keys corrected, 136 accepted. **31 exams** = 28 training variants (9 trainings; ≥80 verified Qs → 4 variants, 60–79 → 3) + 3 comprehensive (`PHI-COMP`, `LOG-COMP`, `PHLO-COMP`). All 20 Qs each, no overlap between variants of the same training.
- **Term 2:** 254 Qs = 234 verified + 20 authored (for تدريب «الأخلاق المهنية» only). Source: 235 Qs, 1 quarantined, 22 keys corrected. **12 exams** (4 trainings × 3 variants), no comprehensive.
- Question fields: `id, subject, grade, academicYear, section, chapter, training, question, A–D, correctAnswer, difficulty (easy/medium/hard), tags, source, verificationStatus, authorCreated, term` (term on T2 + authored T1 items). No letter prefixes in options. Zero duplicate question texts in both banks.
- `validatePhiloSystem()` ✅ and `validatePhiloTerm2System()` ✅ pass (counts, unique IDs, valid keys, 20-per-exam, index ranges, no intra-training overlap).

### Exam hierarchy (as served to students)
`Subject → (Psychology: Unit → Topic/Comprehensive) | (Philosophy: Term → Section → Chapter → Training → Variant exam, + section & subject comprehensive)`

## 3. Exam Session & Grading Flow (audited + runtime-tested)

1. `getExam(subjectId, examId)` → creates UUID session + random seed, **options shuffled per-question server-side** (deterministic mulberry32 PRNG seeded per question), stores session in Cache (6 h), returns questions **without answer keys** + HMAC-SHA256 signature over `sessionId|subjectId|examId|seed` (secret in Script Properties).
2. Client blocks submit until all answered; **server independently re-verifies completeness** (answers must be 0–3 for every question) — client "completed" flag is not trusted.
3. `submitExam()` re-derives correct option ids from the seed, grades server-side, saves to Sheet, returns score/percentage/meta. Correct answers are **never** sent to the browser, even after grading.
4. Duplicate submission → returns the cached result instead of appending a new row.
5. Tampered/missing signature or seed → rejected. **Verified:** all 73 exams round-trip to a perfect 20/20 (60/60) score; tampering and incomplete submissions correctly rejected.

## 4. Student Frontend (`Index.html`)

- Arabic RTL, Tajawal font, themable via CSS custom properties (primary/accent colors from settings, tint/shade helpers regenerate the palette).
- Flow: student name + optional-required phone → subject cards (Philosophy first, Psychology second) → hierarchical browsing (psych: unit cards → exam list; philo: term → section → chapter → training variants, with breadcrumb) → quiz.
- Quiz: question navigator chips (answered/current states), progress bar, prev/next, "next unanswered" jump, keyboard arrows, submit-confirm modal that **blocks submission with N unanswered** and offers a jump button, exit confirm modal.
- Result screen: score, %, performance band (≥75 good / ≥50 mid / low), exam meta (subject, term, section, chapter, training, date), retake / home actions. No correct answers revealed.
- Branding: logo text or teacher photo (fetched as data URL via `getTeacherImage`), hero, chips with live counts (2 subjects · 30 psych exams · 43 philo exams), footer with teacher name/year and **sanitized social links** (https-only, ordered).
- Responsive (360/390/412 px breakpoints, ≥46–48 px touch targets, no horizontal scroll), ARIA roles/labels, `prefers-reduced-motion` support. All user data HTML-escaped (`esc()`).

## 5. Teacher / Profile & Admin Functionality (`Admin.html` + admin API)

- **Login:** PIN (default `1234`, changeable; stored in Script Properties; never returned to browser). Every admin RPC re-checks the PIN (`assertAdmin_`).
- **7 tabs:** Overview (per-subject cards: exams/questions/attempts/avg + verification stats + recent results), Psychology, Philosophy & Logic (term-split stats: verified/authored/corrected/excluded, exam hierarchy, audit log, recent results), Question Bank (filter by subject/term/chapter/training/difficulty/status + search; answer key visible to admin only; caps at 500 rows), Exams (hierarchy with difficulty distribution + audit), Results (filter by subject, search, stats cards, CSV export with BOM), Settings.
- **Settings:** teacher name, subject, grade, year, app title/subtitle, logo text, welcome text, colors (picker + hex, live preview), require-phone toggle, new PIN, **teacher photo** (JPEG/PNG/WebP ≤ 2 MB → Google Drive, old photo trashed on replace/delete), **social links** (WhatsApp/Facebook/TikTok: enable, display name, URL, order — sanitized server-side).
- Results link (auto-created Google Sheet) shown in the top bar.

## 6. Google Sheets / Forms / Drive Integration

- **Results storage:** an auto-created Google Spreadsheet (`SpreadsheetApp.create`, ID persisted in Script Properties `RESULTS_SPREADSHEET_ID`) with sheet «النتائج», 12 columns: التاريخ والوقت، اسم الطالب، رقم الهاتف، الوحدة/القسم، نوع الامتحان، الامتحان، عدد الأسئلة، الدرجة، النسبة %، تفاصيل الإجابات (JSON)، المادة، الترم. Frozen header; migration adds the «الترم» column to legacy sheets. Teacher opens it via `getResultsLink` / dashboard link.
- **No Google Forms** usage — results come only from in-app exam submissions.
- **Drive:** teacher photo only.
- **No production results data exists in this repository** — results live exclusively in the deployed project's Sheet (runtime data, not source). The repo contains question banks + code only; there is nothing to delete or migrate here.

## 7. Configuration & State (Script Properties)

| Key | Purpose |
|---|---|
| `APP_SETTINGS` | Full brand settings JSON (`DEFAULT_SETTINGS` fallback: د. مصطفى تيتو، منصة الامتحانات التعليمية، #123B40/#C9A86A، PIN 1234، requirePhone true, no photo, 3 social links disabled) |
| `SESSION_SECRET` | Auto-generated HMAC secret |
| `RESULTS_SPREADSHEET_ID` | Results spreadsheet |

`Config.gs` holds only the version constant. Everything user-facing is editable from the admin UI without touching code (the repo is a **master template** — copied per teacher, per README).

## 8. Deployment Setup

Manual GAS deployment (no `clasp`, no `appsscript.json` manifest in repo): create GAS project → paste the 7 code files with exact names → run `initializeSystem()` once → run the 3 validators → Deploy → Web app → *Execute as Me* / *Anyone* → students use `/exec`, teacher uses `/exec?page=admin`. Cloning for another teacher = copy the GAS project + re-initialize (independent results Sheet).

## 9. Security Posture (verified)

- ✅ Server-side grading; answer key never leaves the server (verified in payload inspection).
- ✅ HMAC-signed sessions; forged signature rejected; seed/sessionId required.
- ✅ Server-side completeness check; no trust in client flags.
- ✅ Admin PIN gating on every privileged RPC; PIN never returned.
- ✅ Social links: https-only, HTML-tag stripping, length caps, server-side sanitization (tested: `javascript:` URL and `<b>` in label both neutralized).
- ✅ XSS: `esc()` on all user data in both UIs; phone regex `^[0-9+\- ]{4,25}$`; name ≤ 120 chars.
- ✅ Photo upload: MIME + 2 MB caps enforced client & server side; old file trashed.
- ⚠️ Minor observations (not defects blocking anything): default PIN is 1234 until changed; duplicate-submission guard is best-effort (Cache-based); psychology exam cards in the admin hierarchy always display "الترم الأول" label (cosmetic — psychology has no terms); results Sheet is readable by anyone with the link shared by the teacher.

## 10. Constraints Honored Going Forward

- `Data.gs` (psychology) is **protected and must not be modified** (including the known U2-T1 duplication — preserved deliberately per README).
- Philosophy banks are fully verified — any new questions must follow the documented rules (authored-from-curriculum only, `authorCreated` tagging, no cross-training imports, quarantine for unverifiable items) and keep validators passing.
- No rebuild, no demo data, no fake data, no deletion of production data — production data (results) is not in this repo at all.

**Audit result: repository is healthy. All validators pass; all 73 exams grade correctly end-to-end; architecture and data are fully mapped. Ready for the MASTER PROMPT requirements.**
