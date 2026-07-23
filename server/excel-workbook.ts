import ExcelJS from 'exceljs'
import type { CellValue, Worksheet } from 'exceljs'
import type { ExcelApplicationRecord, ExcelExportFilters } from './excel-data.js'
import { filtersForAudit, finalDecision } from './excel-data.js'

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const games = ['Mobile Legends', 'Bloodstrike', 'Farlight']

export { EXCEL_MIME }

export interface WorkbookMetadata {
  generatedBy: string
  filters: ExcelExportFilters
  generatedAt?: Date
  systemVersion?: string
}

function text(value: string | null | undefined) {
  return (value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function date(value: string | null | undefined): Date | '' {
  if (!value) return ''
  const result = new Date(value)
  return Number.isNaN(result.getTime()) ? '' : result
}

function yesNo(value: boolean | null) {
  return value === null ? 'Unavailable' : value ? 'Yes' : 'No'
}

function prepareSheet(sheet: Worksheet, widths: number[], wrapColumns: number[] = []) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.properties.defaultRowHeight = 18
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = Math.min(width, 55)
  })
  for (const columnNumber of wrapColumns) {
    sheet.getColumn(columnNumber).alignment = { vertical: 'top', wrapText: true }
  }
  sheet.getRow(1).height = 28
}

function addStatusFormatting(sheet: Worksheet, columnLetter: string, rowCount: number) {
  const ref = `${columnLetter}2:${columnLetter}${Math.max(2, rowCount + 1)}`
  const rule = (value: string, color: string, priority: number) => ({
    type: 'expression' as const,
    priority,
    formulae: [`${columnLetter}2="${value}"`],
    style: {
      fill: { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: color } },
      font: { color: { argb: 'FFFFFFFF' }, bold: true },
    },
  })
  sheet.addConditionalFormatting({
    ref,
    rules: [
      rule('PENDING_REVIEW', 'FFF59E0B', 1),
      rule('APPROVED', 'FF16A34A', 2),
      rule('REJECTED', 'FFDC2626', 3),
      rule('DISCORD_JOIN_FAILED', 'FFF97316', 4),
      rule('COMPLETED', 'FF2563EB', 5),
    ],
  })
}

function addApplicantsSheet(workbook: ExcelJS.Workbook, records: ExcelApplicationRecord[]) {
  const sheet = workbook.addWorksheet('Applicants', { views: [{ state: 'frozen', ySplit: 1 }] })
  const columns = [
    'Application ID', 'Submission Date', 'In Game Name', 'Discord Username', 'Discord User ID', 'Age Group', 'Sex',
    'Device', 'Games Applied For', 'Willing to Use Clan Tag', 'Play Frequency', 'Previous Clan', 'Reason for Leaving',
    'Facebook Profile Link', 'Where They Found NightRaid', 'Already Joined Discord', 'Discord Membership Verified',
    'Reason for Joining', 'AI Score', 'AI Recommendation', 'AI Confidence', 'AI Strengths', 'AI Concerns',
    'Application Status', 'Final Decision', 'Rejection Reason', 'Reviewed By', 'Review Date',
    'Discord Onboarding Status', 'Assigned Roles', 'Last Updated',
  ]
  const rows: CellValue[][] = records.map(({ application, evaluation }) => [
    application.application_number,
    date(application.submitted_at),
    text(application.in_game_name),
    text(application.discord_username),
    text(application.discord_user_id),
    application.age_group,
    application.sex,
    application.device,
    application.games.join(', '),
    yesNo(application.willing_to_use_clan_tag),
    application.play_frequency,
    text(application.previous_clan),
    text(application.previous_clan_leaving_reason),
    application.facebook_profile_url ? { text: application.facebook_profile_url, hyperlink: application.facebook_profile_url } : '',
    application.discovery_source_other
      ? `${application.discovery_source}: ${text(application.discovery_source_other)}`
      : application.discovery_source,
    yesNo(application.already_joined_discord),
    yesNo(application.discord_membership_verified),
    text(application.reason_for_joining),
    evaluation?.score ?? '',
    evaluation?.recommendation ?? '',
    evaluation?.confidence ?? '',
    evaluation?.strengths.join(' | ') ?? '',
    evaluation?.concerns.join(' | ') ?? '',
    application.status,
    finalDecision(application),
    text(application.decision_reason),
    text(application.reviewed_by),
    date(application.reviewed_at),
    application.discord_onboarding_status,
    application.assigned_discord_roles.join(', '),
    date(application.updated_at),
  ])
  sheet.addTable({
    name: 'ApplicantsTable',
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: columns.map((name) => ({ name, filterButton: true })),
    rows,
  })
  prepareSheet(sheet, [18, 20, 20, 22, 22, 18, 11, 12, 30, 18, 20, 22, 48, 42, 25, 18, 21, 50, 12, 20, 14, 45, 45, 20, 17, 35, 22, 20, 24, 30, 20], [9, 13, 18, 22, 23, 26, 30])
  for (const column of [2, 28, 31]) sheet.getColumn(column).numFmt = 'yyyy-mm-dd hh:mm'
  sheet.getColumn(21).numFmt = '0%'
  addStatusFormatting(sheet, 'X', records.length)
  return sheet
}

function addEvaluationsSheet(workbook: ExcelJS.Workbook, records: ExcelApplicationRecord[]) {
  const sheet = workbook.addWorksheet('AI Evaluations')
  const columns = [
    'Application ID', 'AI Score', 'Recommendation', 'Confidence', 'Motivation Score', 'Teamwork Score',
    'Activity Score', 'Clan Commitment Score', 'Consistency Score', 'Communication Score', 'Strengths', 'Concerns',
    'Summary', 'AI Model', 'Prompt Version', 'Evaluation Date',
  ]
  const rows: CellValue[][] = records
    .filter((record) => record.evaluation)
    .map(({ application, evaluation }) => [
      application.application_number,
      evaluation?.score ?? '',
      evaluation?.recommendation ?? '',
      evaluation?.confidence ?? '',
      evaluation?.motivation_score ?? '',
      evaluation?.teamwork_score ?? '',
      evaluation?.activity_score ?? '',
      evaluation?.clan_commitment_score ?? '',
      evaluation?.consistency_score ?? '',
      evaluation?.communication_score ?? '',
      evaluation?.strengths.join(' | ') ?? '',
      evaluation?.concerns.join(' | ') ?? '',
      text(evaluation?.summary),
      text(evaluation?.model),
      text(evaluation?.prompt_version),
      date(evaluation?.created_at),
    ])
  sheet.addTable({
    name: 'AIEvaluationsTable', ref: 'A1', headerRow: true, totalsRow: false,
    style: { theme: 'TableStyleMedium4', showRowStripes: true },
    columns: columns.map((name) => ({ name, filterButton: true })), rows,
  })
  prepareSheet(sheet, [18, 12, 20, 14, 17, 16, 15, 22, 18, 20, 45, 45, 55, 24, 20, 20], [11, 12, 13])
  sheet.getColumn(4).numFmt = '0%'
  sheet.getColumn(16).numFmt = 'yyyy-mm-dd hh:mm'
  return sheet
}

function addDecisionsSheet(workbook: ExcelJS.Workbook, records: ExcelApplicationRecord[]) {
  const sheet = workbook.addWorksheet('Decisions')
  const columns = [
    'Application ID', 'In Game Name', 'Decision', 'Decision Reason', 'Decision Source', 'Administrator',
    'Decision Date', 'Discord Onboarding Result', 'Assigned Roles',
  ]
  const rows: CellValue[][] = records
    .filter((record) => record.decision || finalDecision(record.application) !== 'PENDING')
    .map(({ application, decision }) => [
      application.application_number,
      text(application.in_game_name),
      decision?.decision ?? finalDecision(application),
      text(decision?.decision_reason ?? application.decision_reason),
      decision?.decision_source ?? '',
      text(decision?.decided_by ?? application.reviewed_by),
      date(decision?.decided_at ?? application.reviewed_at),
      application.discord_onboarding_status,
      application.assigned_discord_roles.join(', '),
    ])
  sheet.addTable({
    name: 'DecisionsTable', ref: 'A1', headerRow: true, totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: columns.map((name) => ({ name, filterButton: true })), rows,
  })
  prepareSheet(sheet, [18, 20, 16, 45, 18, 24, 20, 26, 32], [4, 9])
  sheet.getColumn(7).numFmt = 'yyyy-mm-dd hh:mm'
  return sheet
}

function addSummarySheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet('Recruitment Summary', { views: [{ showGridLines: false }] })
  sheet.columns = [{ width: 34 }, { width: 22 }]
  sheet.addRow(['NIGHTRAID RECRUITMENT SUMMARY', 'VALUE'])
  const summaryRows: Array<[string, string, number | string]> = [
    ['Total applications', 'COUNTA(ApplicantsTable[Application ID])', 0],
    ['Pending applications', 'COUNTIF(ApplicantsTable[Final Decision],"PENDING")', 0],
    ['Approved applicants', 'COUNTIF(ApplicantsTable[Final Decision],"APPROVED")', 0],
    ['Rejected applicants', 'COUNTIF(ApplicantsTable[Final Decision],"REJECTED")', 0],
    ['Approval rate', 'IFERROR(COUNTIF(ApplicantsTable[Final Decision],"APPROVED")/(COUNTIF(ApplicantsTable[Final Decision],"APPROVED")+COUNTIF(ApplicantsTable[Final Decision],"REJECTED")),0)', 0],
    ['Average AI score', 'IFERROR(AVERAGE(ApplicantsTable[AI Score]),0)', 0],
    ['Discord onboarding success rate', 'IFERROR(COUNTIF(ApplicantsTable[Discord Onboarding Status],"COMPLETED")/COUNTIF(ApplicantsTable[Final Decision],"APPROVED"),0)', 0],
  ]
  for (const [label, formula, result] of summaryRows) sheet.addRow([label, { formula, result }])
  sheet.addRow([])
  sheet.addRow(['APPLICATIONS BY GAME', 'COUNT'])
  for (const game of games) {
    sheet.addRow([game, { formula: `COUNTIF(ApplicantsTable[Games Applied For],"*${game}*")`, result: 0 }])
  }
  sheet.addRow([])
  sheet.addRow(['APPLICATIONS BY DEVICE', 'COUNT'])
  for (const device of ['PC', 'Mobile']) {
    sheet.addRow([device, { formula: `COUNTIF(ApplicantsTable[Device],"${device}")`, result: 0 }])
  }
  sheet.addRow([])
  sheet.addRow(['APPLICATIONS BY RECRUITMENT SOURCE', 'COUNT'])
  for (const source of ['Facebook', 'TikTok', 'Discord', 'Others']) {
    sheet.addRow([source, { formula: `COUNTIF(ApplicantsTable[Where They Found NightRaid],"${source}*")`, result: 0 }])
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 14 }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7F1D1D' } }
  for (const row of [10, 20, 24]) {
    sheet.getRow(row).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(row).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } }
  }
  sheet.getCell('B6').numFmt = '0.0%'
  sheet.getCell('B8').numFmt = '0.0%'
  return sheet
}

function addExportInformationSheet(workbook: ExcelJS.Workbook, records: ExcelApplicationRecord[], metadata: WorkbookMetadata) {
  const generatedAt = metadata.generatedAt ?? new Date()
  const sheet = workbook.addWorksheet('Export Information', { views: [{ showGridLines: false }] })
  sheet.columns = [{ width: 28 }, { width: 75 }]
  sheet.addRows([
    ['NIGHTRAID EXPORT INFORMATION', 'VALUE'],
    ['Workbook generated date', generatedAt],
    ['Date range included', `${metadata.filters.dateFrom ?? 'All'} to ${metadata.filters.dateTo ?? 'All'}`],
    ['Filters used', JSON.stringify(filtersForAudit(metadata.filters)) || '{}'],
    ['Generated by', text(metadata.generatedBy)],
    ['Total exported records', records.length],
    ['System version', metadata.systemVersion ?? 'Phase 6'],
  ])
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7F1D1D' } }
  sheet.getColumn(2).alignment = { vertical: 'top', wrapText: true }
  sheet.getCell('B2').numFmt = 'yyyy-mm-dd hh:mm'
  return sheet
}

export async function buildNightRaidWorkbook(records: ExcelApplicationRecord[], metadata: WorkbookMetadata) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'NightRaid Recruitment System'
  workbook.company = 'NightRaid BG'
  workbook.created = metadata.generatedAt ?? new Date()
  workbook.modified = metadata.generatedAt ?? new Date()
  workbook.calcProperties.fullCalcOnLoad = true
  addApplicantsSheet(workbook, records)
  addEvaluationsSheet(workbook, records)
  addDecisionsSheet(workbook, records)
  addSummarySheet(workbook)
  addExportInformationSheet(workbook, records, metadata)
  const output = await workbook.xlsx.writeBuffer()
  return Buffer.from(output)
}
