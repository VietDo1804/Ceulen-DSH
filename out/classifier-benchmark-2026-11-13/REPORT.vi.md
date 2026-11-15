# Benchmark classifier: MiMo V2.6 Flash vs Muse Spark 1.3 Contributor

**Ngày đo: 13/11/2026 · Provider: OpenCode Go · Kết luận: giữ MiMo làm primary nếu ưu tiên tốc độ.**

Model Muse đúng trong catalog là `muse-spark-1.3-contributor`, không phải `muse-1.3-contributor`. Không thay đổi cấu hình production trong quá trình benchmark.

## 1. Kết luận thực dụng

- **MiMo nhanh và dùng được nhiều hơn trong module hiện tại:** median thời gian chờ **3,44 giây**, so với **21,34 giây** của Muse mặc định; MiMo nhanh hơn **51/54 cặp cùng input**.
- MiMo không gặp deadline/capacity error trong 54 lượt, nhưng **9 lượt bị parser từ chối vì schema**. Vì vậy không thể gọi MiMo là hoàn toàn ổn: riêng `choice` chỉ 8/16 lượt dùng được.
- Muse thường đúng schema và đúng đáp án khi hoàn tất, nhưng **25/54 lượt chạm deadline 25 giây**, thêm **3 lỗi capacity 429** và **1 lượt hết ngân sách output**. Đây là nhược điểm lớn đối với classifier chạy trước một thao tác khác.
- Thử thêm Muse `minimal` cải thiện tỷ lệ hoàn tất trong mẫu riêng, nhưng median vẫn **11,34 giây**, thành công **18/27**. Chưa có lý do đổi primary sang Muse.
- Cấu hình fallback hiện tại là Muse `xhigh`. Với giới hạn 900 output tokens, mẫu bổ sung chỉ thành công **7/12**; không nên coi đây là fallback tương tác nhanh, đáng tin cậy.

Đây là kết luận về **model + provider + transport + prompt/parser + ngân sách hiện tại**, không phải phán quyết model nào thông minh hơn nói chung.

## 2. Cách đo

**147 request có tính điểm**, không tính pilot và một runtime smoke check cuối:

| Nhánh | Số request | Thiết kế |
|---|---:|---|
| MiMo mặc định | 54 | 27 input × 2 lần |
| Muse mặc định | 54 | Cùng 27 input × 2 lần |
| Muse `xhigh` | 12 | Mẫu bổ sung, 3 input mỗi nhóm |
| Muse `minimal` | 27 | Một lượt toàn bộ 27 input |

27 input gồm 10 safety `noul`, 8 intent `choice`, 6 severity `score`, và 3 request batch, mỗi batch có 3 câu hỏi. Có tiếng Việt/Anh, lệnh phá hủy so với dữ liệu tái tạo được, prompt injection, lệnh chỉ được trích dẫn chứ không thực thi, và log nhiễu khoảng 0/4.000/11.000 ký tự.

Main benchmark gọi **tuần tự**, đổi thứ tự A/B và B/A theo input và lần lặp để giảm thiên lệch do thời điểm/cache. Không tạo tải đồng thời lên hai model. Hai nhánh reasoning bổ sung chạy sau main, nên **không phải thí nghiệm A/B ghép cặp** và không dùng để khẳng định effort nào nhanh hơn một cách nhân quả.

Dùng đúng SYSTEM prompt từ source, `temperature=0`, `maxTokens=900`, `clampText` 12.000 ký tự, parser/validator thật của module, session header OpenCode, và adapter pi-ai đang cài. Có assertion kiểm tra SYSTEM thực sự nằm trong payload gửi đi. MiMo dùng Completions; Muse dùng Responses theo catalog thực tế. Không tự thay transport của Muse thành Completions, không fallback sang model khác trong một request đo.

**Deadline 25 giây khớp destructive-command gate.** Tool `classify` gọi trực tiếp hiện cho 30 giây: benchmark không chứng minh tỷ lệ hoàn tất tại 30 giây.

## 3. Tốc độ — so sánh chính, cùng 54 input/lần lặp

Đơn vị: giây.

| Chỉ số | MiMo mặc định | Muse mặc định |
|---|---:|---:|
| Tổng thời gian chờ p50 | **3,44** | 21,34 |
| Tổng thời gian chờ p90 | **6,83** | 25,00 — chạm trần |
| Tổng thời gian chờ p95 | **9,40** | 25,00 — chạm trần |
| Thời gian chờ trung bình | **4,22** | 17,44 |
| TTFT p50, chỉ lượt có text | **2,60** (54 lượt) | 9,30 (26 lượt) |
| Tổng p50, chỉ lượt valid | **3,00** (45 lượt) | 8,99 (25 lượt) |
| Trả kết quả valid dưới 5 giây | **36/54 — 66,7%** | 1/54 — 1,9% |
| Trả kết quả valid dưới 10 giây | **45/54 — 83,3%** | 14/54 — 25,9% |
| Lỗi ở deadline 25 giây | **0/54** | 25/54 — 46,3% |

**Theo cặp cùng input:** MiMo nhanh hơn 51/54 lần, median chênh lệch **16,12 giây**; median tỷ số thời gian Muse/MiMo theo cặp là **4,65×**. Tỷ số giữa hai median tổng thể là khoảng **6,20×**; đây là hai phép tính khác nhau.

### Diễn giải cho đúng

- TTFT là lúc xuất hiện **text người dùng đọc được**, không phải HTTP byte đầu tiên hay hidden reasoning token đầu tiên.
- Muse có nhiều lượt không ra text; chúng không nằm trong median TTFT. Không dùng TTFT có điều kiện này để che tỷ lệ thất bại.
- Tổng thời gian chờ tính cả request lỗi. Một lỗi 429 trả nhanh không phải một câu trả lời nhanh, nên bảng SLO yêu cầu kết quả phải valid.
- Các request bị hủy tại 25 giây là **right-censored**: chưa biết model cần bao lâu nếu cho chạy tiếp. P95 25 giây của Muse không có nghĩa model luôn trả xong trước 25 giây.
- Đây là latency một request, không phải benchmark throughput/concurrency. Với JSON ngắn, TTFT và hidden reasoning quan trọng hơn một con số tokens/second.

## 4. Chất lượng sử dụng được trong module hiện tại

Một request được tính đúng chỉ khi vượt parser/validator **và tất cả câu hỏi trong request đúng**.

| Nhóm | MiMo mặc định | Muse mặc định |
|---|---:|---:|
| Safety `noul` | **20/20** | 9/20 |
| Intent `choice` | 8/16 | 8/16 |
| Severity `score` | **12/12** | 7/12 |
| Batch 3 câu hỏi | **5/6** | 1/6 |
| **Tổng request đúng, dùng được** | **45/54 — 83,3%** | **25/54 — 46,3%** |
| Số câu hỏi đúng / tổng kỳ vọng | **55/66** | 27/66 |

**Không có đáp án sai về nội dung trong các request vượt validator**, ở cả hai model và hai nhánh bổ sung. Điều này không chứng minh accuracy thực tế 100%: mẫu nhỏ, bài tổng hợp, và phần request thất bại đã bị loại khi nhìn riêng nhóm valid.

### MiMo: điểm yếu chính là tương thích schema `choice`

MiMo có 9 lỗi validation, không phải timeout. Trong 8/9 lỗi, raw JSON có thêm lớp type, ví dụ:

```json
{"route":{"choice":{"option":"edit","probabilities":{"lookup":0,"edit":0.97,"destructive":0.03},"confidence":0.95}}}
```

Module cần dạng:

```json
{"route":{"option":"edit","probabilities":{"lookup":0,"edit":0.97,"destructive":0.03},"confidence":0.95}}
```

`normalizeAnswers` lấy object theo question id rồi `checkAnswer` tìm `record.option`; nó chưa unwrap `record.choice`. Vì vậy đáp án đúng về ý định vẫn bị từ chối. Có 8 lỗi ở nhóm choice riêng và 1 ở batch.

**Hệ quả production:** lỗi schema có thể kích hoạt fallback Muse `xhigh`, khiến thời gian thực tế của một tool call dài hơn thời gian primary MiMo. Benchmark đo riêng từng model, không tuyên bố đã đo end-to-end toàn chuỗi fallback.

### Muse mặc định: thất bại chủ yếu do phục vụ và ngân sách

29 request không dùng được:

- 25 lỗi chạm deadline.
- 3 lỗi HTTP 429 `admission_capacity_exceeded`: provider báo slot dispatch bị thu hồi. Đây là bằng chứng vấn đề capacity trên route này tại thời điểm đo, không phải bằng chứng model suy luận sai.
- 1 lần stop reason `length`, không có JSON hợp lệ sau khi reasoning tiêu ngân sách output.

Đây là lý do không nên chỉ nhìn “Muse trả schema đẹp” rồi chọn cho một gate nhạy latency.

## 5. Thử effort của Muse

| Chỉ số | Default, n=54 | `minimal`, n=27 | `xhigh`, n=12 |
|---|---:|---:|---:|
| Tổng p50 | 21,34s | 11,34s | 11,23s |
| Tổng p95 | 25,00s | 25,00s | 25,00s |
| Request đúng, valid | 25/54 — 46,3% | 18/27 — 66,7% | 7/12 — 58,3% |
| Lỗi ở deadline | 25 | 6 | 3 |
| Hết output budget | 1 | 0 | 2 |
| Valid dưới 5s | 1/54 | 8/27 | 1/12 |
| Valid dưới 10s | 14/54 | 9/27 | 5/12 |

`minimal` vẫn có 3 lỗi 429 ngoài 6 deadline. Nhánh này không có lỗi schema/token-budget trong mẫu đã đo. `xhigh` có 2 lỗi hết output budget và 3 deadline; cả 3 batch đều thất bại.

**Không kết luận `xhigh` nhanh hơn `minimal` hoặc default:** mẫu input, số lượt, thời điểm và trạng thái provider khác nhau. Mục đích là kiểm tra xem effort tuning có biến Muse thành lựa chọn primary nhanh, ổn định hay không; dữ liệu hiện tại chưa cho thấy điều đó.

“Default” nghĩa là module không truyền reasoning effort. Không đồng nghĩa đã tắt thinking: Muse không có mapping `off` hỗ trợ trong catalog; payload mặc định không ép effort `none`. Raw usage xác nhận có hidden reasoning.

## 6. Khuyến nghị

1. **Giữ `mimo-v2.6-flash` làm primary.** Đặc biệt cho safety `noul`, kết quả hiện tại mạnh hơn rõ: 20/20 valid và đúng, p50 2,48s; Muse 9/20, median chờ gần 25s.
2. **Ưu tiên xử lý lỗi nested schema ở lớp dùng chung**, kèm regression check và vẫn giữ toàn bộ validation. Đây có khả năng đem lại lợi ích thực dụng hơn việc đổi model. Chưa áp dụng thay đổi vì yêu cầu hiện tại là benchmark/compare.
3. **Không tăng reasoning lên `xhigh` chỉ để có classifier tốt hơn.** Ngân sách 900 tokens là một trần thực tế; tăng output budget/timeout sẽ đổi bài toán latency và cần đo lại.
4. Nếu muốn dùng Muse làm fallback, `minimal` là ứng viên đáng đo A/B thêm hơn `xhigh` đối với tác vụ typed JSON ngắn; chưa đủ dữ liệu để tự đổi config.
5. Deadline của primary/fallback trong `askClassifier` là **ngân sách chung**. Primary timeout có thể để lại không đủ thời gian cho fallback; các số Muse độc lập với đầy đủ 25 giây ở đây còn thuận lợi hơn việc chỉ nhận phần thời gian còn lại.

Một runtime `classify` smoke check cuối, dùng chính bảng số liệu này để chọn giữa hai ứng viên, trả option **`mimo`**. Đây chỉ là kiểm tra đường gọi thật và kiểm tra tính nhất quán khuyến nghị, không phải một phiếu độc lập chứng minh model thắng.

## 7. Giới hạn và chi phí

- Chỉ đo trên tài khoản/route OpenCode Go này, trong một phiên ngày 13/11/2026. Không tách được latency intrinsic của model khỏi queue, load, network và transport.
- 27 tình huống tổng hợp và hai lần lặp chưa đủ cho kết luận calibration/safety rộng. Không nên suy rộng “không false-allow trong mẫu” thành bảo đảm không false-allow ngoài thực tế.
- Giá catalog cho 1 triệu token input/output: MiMo `$0.14/$0.28`, Muse `$0.10/$0.20`. Đây không phải hóa đơn hay chi phí subscription đã đo. Các lượt timeout không có usage hoàn chỉnh, nên **không dùng tổng SDK cost để khẳng định model nào rẻ hơn trong vận hành**.
- Không sửa prompt/parser/production config để làm đẹp điểm. Pilot lỗi transcript đã được loại; SYSTEM trên wire được assert trước main.

## 8. Dữ liệu và tái lập

Trong cùng thư mục báo cáo:

- `results.jsonl`: dữ liệu từng request; lọc `phase` = `main`, `xhigh`, `minimal`; bỏ `pilot`.
- `cases.json`: input, câu hỏi, đáp án kỳ vọng.
- `summary.json`: thống kê đầy đủ, lỗi, nhóm câu hỏi, cache/token usage.
- `benchmark.mjs`, `analyze.mjs`: script chạy và tính điểm.
- `METHODOLOGY.md`: phương pháp, deadline, cách tái lập và giới hạn chi tiết.

Kiểm chứng: **77/77 test classifier hiện có pass**; syntax check hai script pass; review độc lập về phương pháp và một lần recheck sau sửa harness không còn finding. Cấu hình đọc lại cuối phiên vẫn là MiMo primary, Muse `xhigh` fallback.
