# Atraski People

Internal HR app for Atraski and At Buzz: attendance, leave, WFH, travel claims, KRA/KPI reviews, pay run with a finance check, payslips, and the full hire-to-exit flow (candidate portal, LOI, appointment letter, probation, resignation, handover, No Dues, F&F, relieving letter), with no HR person needed.

- `index.html`: the app (GitHub Pages). Data lives in Supabase behind each person's login and row-level security.
- `join.html`: the candidate portal. Candidates open it from their private emailed link, with no login.
- `supabase/functions/drive/`: the server function for Google Drive, letters, emails and lifecycle steps.
- `drive-bridge/Code.gs`: the Apps Script the CEO runs once in their own Google account. It writes to the private "Atraski People" Drive folder and sends email from their Gmail. The app's Policy settings page fills in the secret.
