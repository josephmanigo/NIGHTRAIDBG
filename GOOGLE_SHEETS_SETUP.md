# Google Sheets accepted-applicant synchronization

NIGHTRAID automatically adds an applicant to the `NIGHTRAID APPLICATION` Google Sheet after an administrator accepts the application. The application number is the unique key, so Discord onboarding retries update the same row instead of creating a duplicate.

Target spreadsheet:

- Spreadsheet ID: `1DmXuFfwGNfn8AZRXFeCMt6xNWjVJ3HH8NXN9Yf5RZVk`
- Tab: `Sheet1`

## 1. Create a Google service account

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable **Google Sheets API**.
4. Open **IAM & Admin → Service Accounts**.
5. Create a service account for NIGHTRAID.
6. Open the service account, choose **Keys → Add key → Create new key → JSON**, and download the JSON file.

Never commit that JSON file or paste its private key into client-side `VITE_*` variables.

## 2. Share the spreadsheet

Open the target spreadsheet and share it with the JSON file's `client_email` value. Give the service account **Editor** access.

## 3. Add Vercel environment variables

Add these server-side variables to Production, Preview, and Development as needed:

```text
GOOGLE_SERVICE_ACCOUNT_EMAIL=<client_email from the JSON file>
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=<private_key from the JSON file>
GOOGLE_SHEETS_SPREADSHEET_ID=1DmXuFfwGNfn8AZRXFeCMt6xNWjVJ3HH8NXN9Yf5RZVk
GOOGLE_SHEETS_TAB_NAME=Sheet1
```

For `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, paste the complete value including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`. Vercel supports the multiline value; a one-line value containing literal `\n` sequences is also accepted by the application.

## 4. Redeploy and verify

1. Redeploy the website after adding the variables.
2. Accept a test application from Application Command.
3. Confirm that `Sheet1` receives the accepted applicant.
4. Retry Discord onboarding for that applicant and confirm the same spreadsheet row is updated rather than duplicated.

If the sheet is empty, the application creates and formats the header row automatically. Rejected and pending applications are never written to this spreadsheet.
