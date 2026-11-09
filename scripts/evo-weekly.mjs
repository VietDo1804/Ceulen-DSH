#!/usr/bin/env node
/** Deterministic weekly audit/publication. No model, rule edits, or code fixes. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregate, eligibleCandidates, loadLedger, promotionText, reportText } from './evo-report.mjs'
import { redact } from './evo-redact.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const DAY = 86_400_000
const escapeHtml = value => redact(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const date = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
const stamp = value => new Date(value).toISOString().slice(0, 10)
const reportStamp = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(value)

export function weeklyData(entries, now = new Date()) {
  const until = now.toISOString()
  const since = new Date(now.getTime() - 7 * DAY).toISOString()
  const previous = aggregate(entries, { since: new Date(now.getTime() - 14 * DAY).toISOString(), until: since })
  const week = aggregate(entries, { since, until })
  const history = aggregate(entries)
  return { since, until, week, previous, history, candidates: eligibleCandidates(history) }
}

export function weeklyHtml(data, { proposal = '', archive = [] } = {}) {
  const { week, previous, history, candidates, since, until } = data
  const stats = agg => `<dl class="stats"><div><dt>Phiên ghi nhận</dt><dd>${agg.sessions}</dd></div><div><dt>Lần lỗi</dt><dd>${agg.failures}</dd></div><div><dt>Nhóm lỗi</dt><dd>${agg.signatures.length}</dd></div></dl>`
  const rows = (items, empty) => items.length === 0 ? `<p class="empty">${empty}</p>` : `<ol class="signatures">${items.map(item => {
    const recent = week.signatures.find(row => row.signature === item.signature)?.count ?? 0
    return `<li data-arrive><p class="evidence">${item.count} lần · ${item.sessions} phiên · tuần này ${recent} lần</p><p class="message">${escapeHtml(item.example)}</p></li>`
  }).join('')}</ol>`
  const delta = week.failures - previous.failures
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evo Weekly · ${escapeHtml(new Date(until).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }))}</title>
<meta name="description" content="Báo cáo Evo: ${week.sessions} phiên có hoạt động, ${week.failures} lỗi có thời gian trong 7 ngày; ${candidates.length} đề xuất đủ ngưỡng. Chỉ audit, chưa áp dụng thay đổi.">
<link rel="stylesheet" href="evo-assets/report.css"><link rel="stylesheet" href="evo-assets/motion.css"></head>
<body><a class="skip" href="#week">Đến nội dung báo cáo</a><main>
<header data-load><p class="eyebrow">CEULEN / BÁO CÁO CẢI TIẾN</p><h1 data-words lang="en">Evo / Weekly</h1>
<p class="lead">Nhìn lại tuần làm việc. Giữ bài học có bằng chứng.</p><p>Từ ${escapeHtml(date(since))} đến ${escapeHtml(date(until))} · giờ Việt Nam.</p>
<p class="status">CHỈ AUDIT VÀ ĐỀ XUẤT · CHƯA ÁP DỤNG THAY ĐỔI</p></header>
<nav aria-label="Các phần báo cáo" data-load><a href="#week">Tuần này</a><a href="#history">Lịch sử</a><a href="#candidates">Đề xuất</a><a href="#method">Cách đọc</a></nav>
<section id="week"><p class="eyebrow">01 / CỬA SỔ 7 NGÀY</p><h2>Tuần này có gì?</h2>${stats(week)}
<p>So với 7 ngày trước: ${delta === 0 ? 'không đổi' : `${delta > 0 ? 'tăng' : 'giảm'} ${Math.abs(delta)}`} lần lỗi có thời gian (${previous.failures} → ${week.failures}). Đây là số lần, không phải tỷ lệ lỗi theo khối lượng công việc.</p>
${history.untimedFailures > 0 ? `<p class="notice">Có ${history.untimedFailures} lỗi lịch sử chưa có thời gian: giữ trong tổng tích lũy, không tự gán vào tuần này hoặc tuần trước.</p>` : '<p>Mỗi lỗi trong dữ liệu hiện có đều có mốc thời gian để phân tuần.</p>'}
${rows(week.signatures.slice(0, 10), 'Không ghi nhận lỗi có mốc thời gian trong cửa sổ này. Điều này không chứng minh mọi tác vụ đều thành công.')}</section>
<section id="history"><p class="eyebrow">02 / KHÔNG GIỚI HẠN 7 NGÀY</p><h2>Lịch sử tích lũy</h2>${stats(history)}<p>Mỗi phiên chỉ tính snapshot mới nhất; mở lại phiên không cộng trùng toàn bộ lịch sử.</p>${rows(history.signatures.slice(0, 10), 'Chưa có bằng chứng lỗi trong ledger.')}</section>
<section id="candidates"><p class="eyebrow">03 / BẰNG CHỨNG TRƯỚC THAY ĐỔI</p><h2>${candidates.length} nhóm đủ điều kiện xem xét</h2>
<p>Ít nhất 5 lần xuất hiện trong ít nhất 3 phiên khác nhau. Đủ ngưỡng chỉ có nghĩa là được đề xuất, không phải đã được chấp nhận.</p>${rows(candidates.slice(0, 25), 'Chưa có nhóm nào đủ cả hai ngưỡng. Không tạo quy tắc chỉ để có một thay đổi.')}
<h3>Bản nháp từ model Evo</h3>${proposal ? `<pre class="draft">${escapeHtml(proposal)}</pre>` : '<p class="empty">Chưa có bản nháp model cho báo cáo này. Số liệu ở trên được tổng hợp bằng script, không phải kết luận của model.</p>'}
<p class="notice">Muốn áp dụng: xem xét đề xuất → chạy probe với bài kiểm tra kết quả thực sự → verdict adopt và hash đúng bản đề xuất → kiểm tra scope. Không có đường bỏ qua bằng chứng thủ công. <code>/evo-apply</code> chỉ hiển thị khối để duyệt, không tự ghi file.</p></section>
<section id="method"><p class="eyebrow">04 / PHẠM VI VÀ GIỚI HẠN</p><h2>Cách đọc báo cáo</h2><ul class="method"><li data-arrive>“Phiên tuần này” dựa vào hoạt động cuối đã ghi hoặc lỗi có thời gian trong cửa sổ. Lỗi được chia tuần theo chính thời điểm xảy ra, không theo ngày phiên được tạo.</li><li data-arrive>Session hiện tại, vừa hoạt động dưới 5 phút, hoặc không đọc được không được ép vào báo cáo. Đây là audit phần bằng chứng đã thu thập, không phải kiểm tra mọi dòng hội thoại bằng model.</li><li data-arrive>Thông tin nhạy cảm được che bằng bộ lọc heuristic trước khi lưu và hiển thị; không bảo đảm nhận diện mọi bí mật và không scrub ngược các kho lưu cũ.</li><li data-arrive>Weekly không sửa code, RULES.md hay settings. Probe cần kiểm tra độc lập đã commit, không phụ thuộc node_modules hoặc file ignored; worktree không cô lập tác động mạng.</li></ul>
${archive.length ? `<h3>Các báo cáo trước</h3><ul class="archives">${archive.map(file => `<li><a href="${escapeHtml(file)}">${escapeHtml(file)}</a></li>`).join('')}</ul>` : ''}</section>
<footer><p>Ceulen Evo · dữ liệu từ ledger đã chuẩn hóa · ngưỡng 5 lần / 3 phiên · báo cáo không phải quyền tự áp dụng.</p></footer></main><script src="evo-assets/motion.js"></script></body></html>`
}

export function writeWeeklyReport(base, now = new Date()) {
  const reports = join(base, 'reports')
  mkdirSync(join(reports, 'evo-assets'), { recursive: true })
  const entries = loadLedger(base)
  const data = weeklyData(entries, now)
  const proposalFile = join(reports, `proposal-${stamp(now)}.md`)
  const proposal = existsSync(proposalFile) ? readFileSync(proposalFile, 'utf8') : ''
  const file = `evo-weekly-${reportStamp(now)}.html`
  for (const name of ['report.css', 'motion.css', 'motion.js']) copyFileSync(join(root, 'evo-assets', name), join(reports, 'evo-assets', name))
  writeFileSync(join(reports, file), weeklyHtml(data, { proposal }))
  writeFileSync(join(reports, `report-${stamp(now)}.md`), reportText(data.history))
  writeFileSync(join(reports, `promotion-${stamp(now)}.md`), promotionText(data.history))
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
  const base = value('--dir') ?? (process.env.EVO_DIR?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'ceulen', 'self-evo'))
  if (!argv.includes('--render-only')) {
    execFileSync(process.execPath, [join(root, 'evo-distill.mjs')], { stdio: 'inherit' })
    execFileSync(process.execPath, [join(root, 'evo-report.mjs'), '--dir', base, '--drain'], { stdio: 'inherit' })
  }
  const report = writeWeeklyReport(base)
  const dashboard = value('--dashboard-root')
  const url = dashboard ? await publishReport(report, dashboard, value('--base-url')) : null
  console.log(JSON.stringify({ file: join(report.reports, report.file), url, candidates: report.data.candidates.length, weekSessions: report.data.week.sessions, weekFailures: report.data.week.failures, auditOnly: true }))
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(error => { console.error(redact(error.message)); process.exitCode = 1 })
