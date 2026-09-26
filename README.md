# ImageFap + Xasiat + Viper Max Downloader

Extension Chrome MV3 chạy cục bộ để tải ảnh full-size từ album/ảnh ImageFap, album Xasiat hoặc thread Viper. Có hàng đợi nhiều album, tự tiếp tục khi bị gián đoạn, và giới hạn tốc độ dùng chung theo từng host.

## Cài đặt

1. Mở `chrome://extensions` và bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục chứa `manifest.json`. Nếu đang dùng bản cũ thì bấm **Reload**.
3. Reload các tab ImageFap/Xasiat/Viper đang mở.
4. Bấm icon extension để mở **side panel**. Trình duyệt không có side panel sẽ mở một cửa sổ điều khiển riêng.

Cần Chrome/Edge 116 trở lên. Brave dùng được; riêng nút Browse (chọn thư mục) cần bật `brave://flags/#file-system-access-api`.

Lần chạy đầu tiên, extension tự chuyển catalog và lịch sử ảnh đã tải của bản 0.5.x sang kho dữ liệu mới. Dữ liệu cũ vẫn được giữ nguyên làm bản sao lưu.

## Cách dùng

- **Tải album đang mở:** mở album/ảnh/thread rồi bấm **Tải cả album** trong panel (mũi tên bên cạnh cho chọn *Chỉ tải trang này*). Có thể dùng chuột phải → *Tải album/thread này*.
- **Nhiều album:** dán link vào ô bên dưới (mỗi dòng một link, Ctrl+Enter để thêm), hoặc chuột phải vào link → *Thêm link này vào hàng đợi*. Các album chạy lần lượt; số album chạy cùng lúc chỉnh được trong Cài đặt → Nâng cao.
- **Tải tiếp / Quét lại:** mở lại một album đã có trong danh sách, panel sẽ hiện hai nút:
  - *Tải tiếp*: chạy tiếp từ đúng vị trí đang dở, không quét lại.
  - *Quét lại*: đọc lại album để lấy ảnh mới thêm vào. Ảnh đã tải vẫn được bỏ qua.
- **Trên mỗi job:** nút bên phải là việc cần làm tiếp theo (tạm dừng, thử lại lỗi, mở trang xác minh, cấp quyền, mở thư mục). Bấm vào job để xem chi tiết: lỗi gần nhất, danh sách ảnh lỗi, đổi thứ tự, xoá (có *Hoàn tác* trong vài giây).
- **Cài đặt** (biểu tượng góc trên): nơi lưu, mức tốc độ *An toàn* (mặc định) / *Cân bằng* / *Nhanh*, mục *Nâng cao* để chỉnh từng thông số.
- **CAPTCHA:** job chuyển sang trạng thái *Cần xác minh*. Bấm *Mở trang xác minh* và làm thủ công. Khi trang hết thử thách, extension tự tiếp tục đúng request bị chặn; nút *Tôi đã xác minh xong* là phương án dự phòng. Extension **không** giải hay vượt CAPTCHA.

Đường dẫn lưu file:

- ImageFap: `Downloads/[thư mục con]/ImageFap/<tên album>/001_<photoId>.jpg`
- Xasiat: `Downloads/[thư mục con]/Xasiat/<tên album>/`
- Viper: `Downloads/[thư mục con]/[Forum 1][Forum 2]-<tiêu đề bài post>/001_<postId>_<tên gốc>.jpg`

Chọn **Thư mục tự chọn → Browse** thì ảnh được ghi thẳng vào thư mục đó, với cùng cấu trúc bên trong. Chế độ này không cần giữ panel mở. Khi trình duyệt khởi động lại và cần cấp lại quyền ghi, job sẽ tạm dừng kèm nút **Cấp quyền**.

## Kiến trúc (0.8)

```
content.js (mỏng)        background.js (service worker, không giữ trạng thái)
  └─ cho engine mượn tab    ├─ tạo/giữ offscreen document
     để đọc trang cùng      ├─ chrome.downloads / tabs / notifications
     origin                 ├─ side panel, menu chuột phải, alarm watchdog
                            └─ chuyển sự kiện (download xong, tab đóng) → engine
                                       │
offscreen.html + lib/engine.js ◄───────┘   (sống lâu, không bị Chrome thu hồi như SW)
  ├─ list    : đọc từng trang album, lưu "frontier" sau mỗi trang
  ├─ resolve : trang ảnh/viewer → URL full-size (+ thu hoạch URL ảnh lân cận)
  ├─ download: pool chung, chia lượt công bằng giữa các job
  ├─ lib/limiter.js : giới hạn tốc độ theo host, AIMD, Retry-After, hold khi CAPTCHA
  └─ lib/store.js   : IndexedDB — jobs, items, history, logs, settings
popup.html/js : side panel — chỉ hiển thị trạng thái engine đẩy về và gửi lệnh
lib/handlers.js : mỗi site một handler (listPage / resolve / historyKey / isExpiredDownload)
adapters/*.js   : bóc tách HTML từng site (giữ từ 0.5.x)
```

Mỗi ảnh là một bản ghi có trạng thái `unresolved → resolving → ready → downloading → done` (hoặc `skipped`, `failed`, `expired`). Mọi bản ghi đều được lưu xuống, nên khi service worker, offscreen hay cả trình duyệt khởi động lại, job chạy tiếp từ đúng ảnh và đúng trang đang dở.

Muốn thêm một site mới: viết một file trong `adapters/`, thêm một handler vào `lib/handlers.js`, rồi khai báo host trong `manifest.json`.

## Kiểm thử

```
npm test          # unit test: helper, limiter, engine (fake network), Node 22+
npm run e2e       # end-to-end: Chromium thật + extension + site giả lập (cần Playwright và openssl)
```

Bản e2e ánh xạ mọi domain về một server HTTPS giả lập (`e2e/fixture-server.js`) và kiểm tra 27 điểm:

- phân trang; lỗi 429 kèm Retry-After;
- ảnh đã bị xoá thì báo lỗi đúng một lần;
- thu hoạch URL ảnh lân cận; đọc trang qua tab;
- CAPTCHA giữa album và tự tiếp tục sau khi giải;
- token Xasiat hết hạn thì đọc lại album;
- Viper với ba loại host ảnh;
- tắt offscreen + service worker giữa lúc tải mà không sinh file trùng hay file lạc chỗ;
- chuyển dữ liệu từ 0.5.x; xuất catalog.

## Cập nhật

### 0.8.0

- Giao diện side panel theo thiết kế mới (Claude Design): màn chính gọn, cài đặt tách riêng, preset tốc độ, xoá có hoàn tác, thanh cảnh báo khi có album cần xử lý.
- Side panel mới: thẻ "Trang hiện tại", hàng đợi có bộ lọc, tốc độ ảnh/phút và thời gian còn lại, trạng thái host đang bị giới hạn.
- Hàng đợi nhiều album: dán nhiều link một lần, thêm từ menu chuột phải, đổi thứ tự, chọn số album chạy cùng lúc.
- Thông báo hệ thống khi job xong hoặc khi cần xác minh CAPTCHA.
- Xuất nhật ký (JSON) để chẩn đoán khi site đổi HTML.
- Tuỳ chọn xoá dòng khỏi danh sách tải của Chrome sau khi xong; file vẫn giữ.
- Có icon.

### 0.7.0

- Engine chuyển sang **offscreen document**: quét và tải không còn phụ thuộc tab. Reload hay đóng tab album thì job vẫn chạy (chuyển sang đọc nền).
- Khi tab album đang mở, trang site được đọc *qua tab đó* (cùng cookie, referer, same-origin như lúc bạn duyệt web); ảnh trên host khác được đọc từ nền nên hết lỗi CORS của Viper.
- Token Xasiat hết hạn (403) được nhận ra và tự đọc lại album để lấy link mới, tối đa 2 lần, thay vì chờ backoff mãi.
- Chế độ Browse ghi file ngay từ engine, dạng stream, không cần giữ cửa sổ điều khiển. File đã có sẵn thì bỏ qua.
- Download đứng yên quá 90 giây mới bị hủy (thay cho mốc cứng 120 giây).
- Nếu engine khởi động lại khi đang tải: download cũ được nhận lại thay vì tải trùng, và bản sao `(1)` phát sinh sẽ tự bị xoá.

### 0.6.0

- Kho dữ liệu chuyển sang **IndexedDB**: ghi từng ảnh thay vì ghi lại cả catalog, không còn giới hạn 30 catalog, 10.000 ảnh mỗi catalog hay 20.000 ID lịch sử.
- **Bộ giới hạn tốc độ theo host**, dùng chung cho mọi job: hai album cùng site không còn gửi gấp đôi request. Số luồng tự điều chỉnh (AIMD): giảm một nửa khi bị 429/503, tăng dần khi ổn định.
- Ảnh ImageFap/Xasiat đã có trong lịch sử được bỏ qua *trước khi* mở trang ảnh, nên không tốn request.
- Thu hoạch URL full-size của ảnh lân cận có sẵn trong trang ảnh, bớt được request.

### 0.5.4

- Sửa vòng lặp vô hạn khi trang ảnh không có URL full-size (trước đây có thể treo tab).
- *Tải tiếp*, *Thử lại lỗi* và tự tải tiếp giữ đúng độ giãn request, không còn chạy 0 ms.
- Sửa lỗi run "zombie" sau khi service worker khởi động lại; bỏ việc inject `lib/sites.js` hai lần.

Lịch sử các bản 0.3–0.5.3 nằm trong `_backup_v0.5.3/README.md`.

## Giới hạn có chủ ý

- Không có server riêng, không gửi dữ liệu ra ngoài, không dùng thư viện hay code tải từ xa.
- Không vượt CAPTCHA, paywall hoặc trang yêu cầu đăng nhập.
- Chỉ dùng với nội dung bạn có quyền lưu và tuân thủ điều khoản của website.
- Website có thể đổi HTML/CDN; khi đó cần cập nhật adapter tương ứng. Nhật ký xuất ra giúp tìm chỗ hỏng.
- Viper hỗ trợ IMX, PiXhost, ImageVenue, PhotosEx, ảnh trực tiếp, và host lạ có trang viewer chứa ảnh. Link `viper.click/expired/...` được ghi lỗi riêng.
- Nếu Chrome bật "Hỏi vị trí lưu cho mỗi file", hãy tắt tuỳ chọn đó trong Settings → Downloads.
