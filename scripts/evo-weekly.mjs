#!/usr/bin/env node
/** Deterministic weekly audit/publication. No model, rule edits, or code fixes. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectReports } from './analyze-tool-use.mjs'
import { eligibleCandidates, fixOutcomes, loadFixes, loadLedger, promotionText, reportText, triage, windows } from './evo-report.mjs'
import { redact } from './evo-redact.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const DAY = 86_400_000
const escapeHtml = value => redact(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const date = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
const stamp = value => new Date(value).toISOString().slice(0, 10)
const reportStamp = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(value)
const number = value => Number(value).toLocaleString('vi-VN')

export function weeklyData(entries, now = new Date(), fixes = []) {
  const data = windows(entries, now)
  const outcomes = fixOutcomes(entries, fixes, now)
  return { ...data, candidates: eligibleCandidates(data.history), outcomes, lists: triage(data, outcomes) }
}

/** Tool calls of the week and of the week before, read from the session logs; undefined when there is nothing to read. */
export function collectToolUse(sessionsRoot, now = new Date()) {
  if (!existsSync(sessionsRoot)) return undefined
  const until = now.getTime()
  const since = until - 7 * DAY
  const [week, previous] = collectReports(sessionsRoot, [{ sinceMs: since, untilMs: until }, { sinceMs: since - 7 * DAY, untilMs: since }])
  return week.calls + previous.calls === 0 ? undefined : { week, previous }
}

/** `[label, week before, this week]` rows: how tools were used, including calls that succeeded with the wrong tool. */
export function toolUseRows({ week, previous }) {
  const total = bag => Object.values(bag ?? {}).reduce((sum, count) => sum + count, 0)
  const share = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1).replace('.', ',')}%` : '–')
  const calls = (report, name) => report.byTool[name] ?? 0
  const edits = report => calls(report, 'edit') + calls(report, 'write') + calls(report, 'apply_patch')
  const scripted = report => report.bashJobs['script file edit'] ?? 0
  const row = (label, pick) => [label, pick(previous), pick(week)]
  return [
    row('Lượt gọi tool', report => number(report.calls)),
    row('Lỗi cứng (tỷ lệ trên lượt gọi)', report => `${number(report.hardErrors)} (${share(report.hardErrors, report.calls)})`),
    row('Gọi tên tool không tồn tại', report => number(report.unknownTool)),
    row('Phần lượt gọi là bash', report => share(calls(report, 'bash'), report.calls)),
    row('Sửa file bằng tool edit thay vì script bash', report => share(edits(report), edits(report) + scripted(report))),
    row('Edit/write bị từ chối vì chưa đọc hoặc file đã đổi', report => number(report.notReadOrStale)),
    row('Gọi tool cold qua ceulen_tools (số lỗi)', report => `${number(total(report.coldCalls))} (${number(total(report.coldErrors))})`),
    row('Script codemode thất bại', report => `${number(report.codemode.failed)} / ${number(report.codemode.scripts)}`),
  ]
}

export function weeklyHtml(data, { proposal = '', archive = [], toolUse } = {}) {
  const { week, previous, history, since, until } = data
  const outcomes = data.outcomes ?? []
  const { work, groups, quiet, external } = data.lists ?? triage(data, outcomes)
  const stats = agg => `<dl class="stats"><div><dt>Phiên ghi nhận</dt><dd>${agg.sessions}</dd></div><div><dt>Lần lỗi</dt><dd>${agg.failures}</dd></div><div><dt>Nhóm lỗi</dt><dd>${agg.signatures.length}</dd></div></dl>`
  const list = (items, evidence, empty) => items.length === 0 ? `<p class="empty">${empty}</p>` : `<ol class="signatures">${items.map(item => `<li data-arrive><p class="evidence">${evidence(item)}</p><p class="message">${escapeHtml(item.example)}</p></li>`).join('')}</ol>`
  const total = item => `${item.count} lần · ${item.sessions} phiên`
  const thisWeek = item => `tuần này ${item.week} lần · 7 ngày trước ${item.previous} lần · tổng ${item.count} lần trong ${item.sessions} phiên`
  const lastSeen = item => `${total(item)} · lần cuối ${escapeHtml(item.last.slice(0, 10))}`
  const withWeek = item => `${total(item)} · tuần này ${week.signatures.find(row => row.signature === item.signature)?.count ?? 0} lần`
  // Per 100 sessions: the two windows rarely hold the same amount of work.
  const rate = window => `${window.count} lần trong ${window.sessions} phiên${window.sessions > 0 ? ` (${((window.count / window.sessions) * 100).toFixed(1).replace('.', ',')} / 100 phiên)` : ''}`
  const verdict = outcome => outcome.after.count > 0 ? 'Còn tái diễn' : outcome.after.sessions >= 10 ? 'Không tái diễn' : 'Chưa đủ phiên để kết luận'
  const fixes = outcomes.length === 0
    ? '<p class="empty">Chưa ghi nhận lần sửa nào. Sau khi một bản sửa được merge, ghi lại bằng <code>evo-report.mjs --fixed</code> để báo cáo sau so được trước và sau.</p>'
    : `<ol class="signatures">${outcomes.map(outcome => `<li data-arrive><p class="evidence">${verdict(outcome)} · sửa lúc ${escapeHtml(date(outcome.at))} · 14 ngày trước đó ${rate(outcome.before)} · từ khi sửa ${rate(outcome.after)}</p><p class="message">${escapeHtml(outcome.note || 'Không có ghi chú.')}</p><p class="message">${escapeHtml(outcome.example)}</p></li>`).join('')}</ol>`
  const tools = toolUse === undefined
    ? '<p class="empty">Chưa có số liệu dùng tool cho báo cáo này: không đọc được log phiên.</p>'
    : `<table class="metrics"><thead><tr><th scope="col">Chỉ số</th><th scope="col">7 ngày trước</th><th scope="col">Tuần này</th></tr></thead><tbody>${toolUseRows(toolUse).map(([label, before, now]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(before)}</td><td>${escapeHtml(now)}</td></tr>`).join('')}</tbody></table>`
  const groupBlocks = groups.map((group, index) => `<article class="group"><h3><span class="index">${String(index + 1).padStart(2, '0')}</span> ${escapeHtml(group.vi)}</h3>
<p class="evidence">tuần này ${group.week} lần · 7 ngày trước ${group.previous} lần · tổng ${group.count} lần · ${group.items.length} chữ ký lỗi${group.where === '' ? '' : ` · chỗ sửa: <code>${escapeHtml(group.where)}</code>`}</p>${group.noteVi === undefined ? '' : `<p>${escapeHtml(group.noteVi)}</p>`}
${list(group.items, thisWeek, '')}</article>`).join('\n')
  const delta = week.failures - previous.failures
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evo Weekly · ${escapeHtml(new Date(until).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }))}</title>
<meta name="description" content="Báo cáo Evo: ${week.sessions} phiên có hoạt động, ${week.failures} lỗi có thời gian trong 7 ngày; ${groups.length} nhóm cần sửa. Chỉ audit, chưa áp dụng thay đổi.">
<link rel="stylesheet" href="evo-assets/report.css"><link rel="stylesheet" href="evo-assets/motion.css"></head>
<body><a class="skip" href="#week">Đến nội dung báo cáo</a><main>
<header data-load><p class="eyebrow">CEULEN / BÁO CÁO CẢI TIẾN</p><h1 data-words lang="en">Evo / Weekly</h1>
<p class="lead">Nhìn lại tuần làm việc. Giữ bài học có bằng chứng.</p><p>Từ ${escapeHtml(date(since))} đến ${escapeHtml(date(until))} · giờ Việt Nam.</p>
<p class="status">CHỈ AUDIT VÀ ĐỀ XUẤT · CHƯA ÁP DỤNG THAY ĐỔI</p></header>
<nav aria-label="Các phần báo cáo" data-load><a href="#week">Tuần này</a><a href="#work">Nhóm cần sửa</a><a href="#watch">Theo dõi</a><a href="#tools">Dùng tool</a><a href="#history">Lịch sử</a><a href="#method">Cách đọc</a></nav>
<section id="week"><p class="eyebrow">01 / CỬA SỔ 7 NGÀY</p><h2>Tuần này có gì?</h2>${stats(week)}
<p>So với 7 ngày trước: ${delta === 0 ? 'không đổi' : `${delta > 0 ? 'tăng' : 'giảm'} ${Math.abs(delta)}`} lần lỗi có thời gian (${previous.failures} → ${week.failures}). Đây là số lần, không phải tỷ lệ lỗi theo khối lượng công việc.</p>
${history.untimedFailures > 0 ? `<p class="notice">Có ${history.untimedFailures} lỗi lịch sử chưa có thời gian: giữ trong tổng tích lũy, không tự gán vào tuần này hoặc tuần trước.</p>` : '<p>Mỗi lỗi trong dữ liệu hiện có đều có mốc thời gian để phân tuần.</p>'}
${list(week.signatures.slice(0, 10), total, 'Không ghi nhận lỗi có mốc thời gian trong cửa sổ này. Điều này không chứng minh mọi tác vụ đều thành công.')}</section>
<section id="work"><p class="eyebrow">02 / NHÓM CẦN SỬA</p><h2>${groups.length} nhóm cần sửa, gom từ ${work.length} chữ ký lỗi</h2>
<p>Mỗi nhóm gom các lỗi có chung một chỗ sửa, nên sửa một nhóm là một việc. Chỉ tính lỗi đủ ngưỡng tích lũy (ít nhất 5 lần trong ít nhất 3 phiên), còn xảy ra trong 7 ngày qua và do tool của ceulen-dsh báo. Nhóm nhiều lần nhất tuần này đứng trước.</p>
${groups.length === 0 ? '<p class="empty">Không có nhóm lỗi nào vừa đủ ngưỡng vừa còn xảy ra tuần này. Không tạo việc chỉ để có việc.</p>' : groupBlocks}
<p class="notice">Muốn áp dụng: mở một phiên review, chọn tối đa ba nhóm ở trên, sửa trong git worktree kèm test, xem diff rồi mới merge; sau đó ghi lại bằng <code>evo-report.mjs --fixed</code>. Dòng rule cho RULES.md vẫn phải qua probe: verdict adopt, hash đúng bản đề xuất và scope hợp lệ; không có đường bỏ qua bằng chứng thủ công. <code>/evo-apply</code> chỉ hiển thị khối để duyệt, không tự ghi file.</p></section>
<section id="watch"><p class="eyebrow">03 / THEO DÕI, KHÔNG CẦN LÀM</p><h2>Đã sửa, đang lặng và ngoài tầm</h2>
<h3>Đã sửa, đang theo dõi</h3>${fixes}
<h3>Đang lặng: ${quiet.length} chữ ký lỗi</h3><p>Đủ ngưỡng tích lũy nhưng không xuất hiện trong 7 ngày qua. Lỗi nào tái diễn sẽ tự quay lại nhóm cần sửa.</p>${list(quiet, lastSeen, 'Không có lỗi nào đang lặng.')}
<h3>Ngoài tầm sửa: ${external.length} sự cố nhà cung cấp</h3><p>Quá tải, hết thời gian chờ hoặc mất kết nối ở phía nhà cung cấp model. Không sửa được bằng rule hay code trong repo này.</p>${list(external, thisWeek, 'Không có sự cố nhà cung cấp nào đủ ngưỡng.')}
<h3>Bản nháp từ model Evo</h3>${proposal ? `<pre class="draft">${escapeHtml(proposal)}</pre>` : '<p class="empty">Chưa có bản nháp model cho báo cáo này. Số liệu ở trên được tổng hợp bằng script, không phải kết luận của model.</p>'}</section>
<section id="tools"><p class="eyebrow">04 / CÁCH MODEL DÙNG TOOL</p><h2>Model đã gọi tool thế nào?</h2>
<p>Đếm từ log phiên, gồm cả những lượt gọi thành công nhưng chọn sai tool, ví dụ dùng bash để tìm hay sửa file. Phần lỗi ở trên không thấy được các lượt này.</p>${tools}</section>
<section id="history"><p class="eyebrow">05 / KHÔNG GIỚI HẠN 7 NGÀY</p><h2>Lịch sử tích lũy</h2>${stats(history)}<p>Mỗi phiên chỉ tính snapshot mới nhất; mở lại phiên không cộng trùng toàn bộ lịch sử.</p>${list(history.signatures.slice(0, 10), withWeek, 'Chưa có bằng chứng lỗi trong ledger.')}</section>
<section id="method"><p class="eyebrow">06 / PHẠM VI VÀ GIỚI HẠN</p><h2>Cách đọc báo cáo</h2><ul class="method"><li data-arrive>“Phiên tuần này” dựa vào hoạt động cuối đã ghi hoặc lỗi có thời gian trong cửa sổ. Lỗi được chia tuần theo chính thời điểm xảy ra, không theo ngày phiên được tạo.</li><li data-arrive>“Nhóm cần sửa” là danh sách để xem xét, không phải danh sách bug. Lỗi được xếp nhóm theo một bảng cố định trong script; lỗi mới chưa có trong bảng hiện thành nhóm riêng ghi “Chưa phân nhóm”. “Ngoài tầm sửa” chỉ nhận diện lỗi do nhà cung cấp trả về khi gọi lại.</li><li data-arrive>Session hiện tại, vừa hoạt động dưới 5 phút, hoặc không đọc được không được ép vào báo cáo. Đây là audit phần bằng chứng đã thu thập, không phải kiểm tra mọi dòng hội thoại bằng model.</li><li data-arrive>Thông tin nhạy cảm được che bằng bộ lọc heuristic trước khi lưu và hiển thị; không bảo đảm nhận diện mọi bí mật và không scrub ngược các kho lưu cũ.</li><li data-arrive>Weekly không sửa code, RULES.md hay settings. Probe cần kiểm tra độc lập đã commit, không phụ thuộc node_modules hoặc file ignored; worktree không cô lập tác động mạng.</li></ul>
${archive.length ? `<h3>Các báo cáo trước</h3><ul class="archives">${archive.map(file => `<li><a href="${escapeHtml(file)}">${escapeHtml(file)}</a></li>`).join('')}</ul>` : ''}</section>
<footer><p>Ceulen Evo · dữ liệu từ ledger đã chuẩn hóa · ngưỡng 5 lần / 3 phiên · báo cáo không phải quyền tự áp dụng.</p></footer></main><script src="evo-assets/motion.js"></script></body></html>`
}

export function writeWeeklyReport(base, now = new Date(), { sessionsRoot } = {}) {
  const reports = join(base, 'reports')
  mkdirSync(join(reports, 'evo-assets'), { recursive: true })
  const entries = loadLedger(base)
  const data = weeklyData(entries, now, loadFixes(base))
  const proposalFile = join(reports, `proposal-${stamp(now)}.md`)
  const proposal = existsSync(proposalFile) ? readFileSync(proposalFile, 'utf8') : ''
  const file = `evo-weekly-${reportStamp(now)}.html`
  for (const name of ['report.css', 'motion.css', 'motion.js']) copyFileSync(join(root, 'evo-assets', name), join(reports, 'evo-assets', name))
  writeFileSync(join(reports, file), weeklyHtml(data, { proposal, toolUse: sessionsRoot === undefined ? undefined : collectToolUse(sessionsRoot, now) }))
  writeFileSync(join(reports, `report-${stamp(now)}.md`), reportText(data.history, 5, data.lists))
  writeFileSync(join(reports, `promotion-${stamp(now)}.md`), promotionText(data.history, 5, data.lists))
  return { file, reports, data }
}

export async function publishReport(report, dashboardRoot, baseUrl) {
  const dashboard = resolve(dashboardRoot)
  const origin = new URL(baseUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('dashboard URL must be an http(s) origin without credentials')
  for (const tree of ['public', 'dist']) {
    const demo = join(dashboard, 'web', tree, 'real', 'demo')
    if (!existsSync(demo)) throw new Error(`existing dashboard demo directory missing: ${demo}`)
    mkdirSync(join(demo, 'evo-assets'), { recursive: true })
    for (const name of ['report.css', 'motion.css', 'motion.js']) copyFileSync(join(report.reports, 'evo-assets', name), join(demo, 'evo-assets', name))
    copyFileSync(join(report.reports, report.file), join(demo, report.file))
  }
  const url = new URL(`/real/demo/${report.file}`, origin).href
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html') || await response.text() !== readFileSync(join(report.reports, report.file), 'utf8')) throw new Error('published dashboard HTML could not be verified')
  const listing = await fetch(new URL('/api/blogs', origin), { signal: AbortSignal.timeout(10_000) })
  const body = listing.ok ? await listing.json() : null
  if (!body?.blogs?.some(page => page.file === report.file)) throw new Error('report missing from dashboard Blog listing')
  return url
}

async function main(argv) {
  const value = flag => {
    if (!argv.includes(flag)) return undefined
    const next = argv[argv.indexOf(flag) + 1]
    if (!next || next.startsWith('--')) throw new Error(`missing value for ${flag}`)
    return next
  }
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const base = value('--dir') ?? (process.env.EVO_DIR?.trim() || join(dshHome, 'ceulen', 'self-evo'))
  if (!argv.includes('--render-only')) {
    execFileSync(process.execPath, [join(root, 'evo-distill.mjs')], { stdio: 'inherit' })
    execFileSync(process.execPath, [join(root, 'evo-report.mjs'), '--dir', base, '--drain'], { stdio: 'inherit' })
  }
  const report = writeWeeklyReport(base, new Date(), { sessionsRoot: value('--sessions') ?? join(dshHome, 'sessions') })
  const dashboard = value('--dashboard-root')
  const url = dashboard ? await publishReport(report, dashboard, value('--base-url')) : null
  console.log(JSON.stringify({ file: join(report.reports, report.file), url, candidates: report.data.candidates.length, fixGroups: report.data.lists.groups.length, workList: report.data.lists.work.length, weekSessions: report.data.week.sessions, weekFailures: report.data.week.failures, auditOnly: true }))
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => { console.error(redact(error.message)); process.exitCode = 1 })
