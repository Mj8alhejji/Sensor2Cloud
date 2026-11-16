#include "Sensor2Cloud.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_system.h>
#include <stdarg.h>
#include <sys/time.h>

// `namespace { ... }` = file-private, like a private static helper in Java.
namespace {

constexpr size_t kMaxLineBytes = 1024;        // server rejects longer lines
constexpr size_t kMaxBatchLines = 100;        // also the "send early" threshold
constexpr size_t kMaxBatchTextBytes = 8 * 1024;
constexpr uint32_t kMaxBackoffMs = 60000;
constexpr uint32_t kHttpTimeoutMs = 5000;
constexpr uint32_t kWifiRetryMs = 15000;
constexpr uint32_t kTaskStackBytes = 8192;
constexpr UBaseType_t kTaskPriority = 1;
constexpr BaseType_t kTaskCore = 0;           // WiFi stack lives here; loop() runs on core 1
constexpr uint8_t kFlagIncomplete = 0x01;

// One stored line. `packed` = no padding bytes, so it is exactly 19 bytes in the ring.
struct __attribute__((packed)) RecordHeader {
  uint32_t seq;
  uint32_t uptimeMs;
  uint64_t tsMs;  // NTP unix ms, 0 if time not synced yet
  uint16_t len;
  uint8_t flags;
};

constexpr size_t kMinBufferBytes = 2 * (sizeof(RecordHeader) + kMaxLineBytes);
constexpr size_t kScratchBytes = kMaxBatchTextBytes + kMaxBatchLines * (sizeof(RecordHeader) + 1);

uint64_t ntpNowMs() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < 1600000000) return 0;  // clock not set by NTP yet
  return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}

// RAII lock: the constructor takes the mutex, the destructor releases it when the
// object goes out of scope (end of the { } block). Like try/finally, but automatic.
class Lock {
 public:
  explicit Lock(SemaphoreHandle_t m) : m_(m) { xSemaphoreTake(m_, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(m_); }
  Lock(const Lock&) = delete;
  Lock& operator=(const Lock&) = delete;

 private:
  SemaphoreHandle_t m_;
};

// millis() wraps every ~49 days; signed difference keeps comparisons correct across the wrap.
bool reached(uint32_t now, uint32_t deadline) { return (int32_t)(now - deadline) >= 0; }

}  // namespace

// ------------------------------------------------------------------ setup

Sensor2Cloud::Sensor2Cloud(const char* wifiSsid, const char* wifiPassword, const char* deviceKey)
    : ssid_(wifiSsid), password_(wifiPassword), deviceKey_(deviceKey) {}

void Sensor2Cloud::server(const char* baseUrl) {
  url_ = baseUrl;
  while (url_.endsWith("/")) url_.remove(url_.length() - 1);
  url_ += "/api/v1/batch";
}

void Sensor2Cloud::nodeName(const char* name) {
  name_ = name;
  if (name_.length() > 64) name_.remove(64);
}

void Sensor2Cloud::sendInterval(uint32_t ms) { intervalMs_ = ms < 200 ? 200 : ms; }

void Sensor2Cloud::debug(Print& out) { debug_ = &out; }

void Sensor2Cloud::onCommand(CommandHandler handler) { commandHandler_ = handler; }

bool Sensor2Cloud::begin(size_t bufferBytes) {
  if (task_) return true;
  if (url_.isEmpty()) {
    log("begin(): call server(\"http://host:port\") first");
    return false;
  }
  if (bufferBytes < kMinBufferBytes) bufferBytes = kMinBufferBytes;

  ring_ = (uint8_t*)malloc(bufferBytes);
  line_ = (uint8_t*)malloc(kMaxLineBytes);
  scratch_ = (uint8_t*)malloc(kScratchBytes);
  if (!ring_ || !line_ || !scratch_) {
    free(ring_);
    free(line_);
    free(scratch_);
    ring_ = line_ = scratch_ = nullptr;
    log("begin(): out of memory for a %u byte buffer", (unsigned)bufferBytes);
    return false;
  }
  ringCap_ = bufferBytes;
  scratchCap_ = kScratchBytes;

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid_.c_str(), password_.c_str());  // returns immediately
  mac_ = WiFi.macAddress();
  bootId_ = esp_random();  // real RNG once the radio is on

  mutex_ = xSemaphoreCreateMutex();  // created last: write() treats mutex_ != nullptr as "ready"
  if (!mutex_) {
    log("begin(): could not create mutex");
    return false;
  }

  if (xTaskCreatePinnedToCore(&Sensor2Cloud::taskEntry, "sensor2cloud", kTaskStackBytes, this,
                              kTaskPriority, &task_, kTaskCore) != pdPASS) {
    task_ = nullptr;
    log("begin(): could not start task");
    return false;
  }

  log("started: mac=%s bootId=%u buffer=%u bytes -> %s", mac_.c_str(), (unsigned)bootId_,
      (unsigned)ringCap_, url_.c_str());
  return true;
}

// ------------------------------------------------------------------ Print

size_t Sensor2Cloud::write(uint8_t b) { return write(&b, 1); }

size_t Sensor2Cloud::write(const uint8_t* data, size_t len) {
  if (!mutex_) return 0;  // begin() not called (or failed)
  bool wakeTask;
  {
    Lock lock(mutex_);
    uint32_t now = millis();
    for (size_t i = 0; i < len; i++) {
      uint8_t c = data[i];
      if (c == '\n') {
        commitLineLocked(0, now);
        continue;
      }
      if (c == '\r' || c == '\0') continue;  // println() sends \r\n; NUL would cut the string
      if (!lineOpen_) {
        lineOpen_ = true;
        lineStartMs_ = now;
      }
      if (lineLen_ == kMaxLineBytes) splitFullLineLocked(c, now);
      line_[lineLen_++] = c;
    }
    lastWriteMs_ = now;
    wakeTask = pendingLines_ >= kMaxBatchLines;
  }
  if (wakeTask && task_) xTaskNotifyGive(task_);
  return len;
}

void Sensor2Cloud::flush() {
  if (!mutex_) return;
  {
    Lock lock(mutex_);
    if (lineOpen_) commitLineLocked(kFlagIncomplete, millis());
  }
  flushRequested_ = true;
  if (task_) xTaskNotifyGive(task_);
}

// ------------------------------------------------------------------ status

bool Sensor2Cloud::connected() const { return WiFi.status() == WL_CONNECTED; }

size_t Sensor2Cloud::queuedLines() const {
  if (!mutex_) return 0;
  Lock lock(mutex_);
  return pendingLines_;
}

uint32_t Sensor2Cloud::droppedLines() const {
  if (!mutex_) return 0;
  Lock lock(mutex_);
  return dropped_;
}

// ------------------------------------------------------------------ line assembly

void Sensor2Cloud::commitLineLocked(uint8_t flags, uint32_t now) {
  uint32_t start = lineOpen_ ? lineStartMs_ : now;  // bare println() = empty line, still sent
  pushRecordLocked(line_, (uint16_t)lineLen_, flags, start);
  lineLen_ = 0;
  lineOpen_ = false;
}

// Line hit 1 KB: ship it as incomplete and keep going in a new line.
// Never cut inside a UTF-8 character, or the server would see broken text.
void Sensor2Cloud::splitFullLineLocked(uint8_t nextByte, uint32_t now) {
  size_t cut = lineLen_;
  if ((nextByte & 0xC0) == 0x80) {  // next byte continues a multi-byte char
    while (cut > 0 && (line_[cut - 1] & 0xC0) == 0x80) cut--;
    if (cut > 0) cut--;  // also move the lead byte
    if (cut == 0) cut = lineLen_;  // garbage, cut anyway
  }
  pushRecordLocked(line_, (uint16_t)cut, kFlagIncomplete, lineStartMs_);
  size_t rest = lineLen_ - cut;
  memmove(line_, line_ + cut, rest);
  lineLen_ = rest;
  lineStartMs_ = now;
}

// Text sitting without a newline for one send interval goes out as incomplete.
void Sensor2Cloud::flushStalePartial(uint32_t now) {
  Lock lock(mutex_);
  if (lineOpen_ && now - lastWriteMs_ >= intervalMs_) commitLineLocked(kFlagIncomplete, now);
}

// ------------------------------------------------------------------ ring buffer

void Sensor2Cloud::pushRecordLocked(const uint8_t* text, uint16_t len, uint8_t flags,
                                    uint32_t uptimeMs) {
  RecordHeader h{nextSeq_++, uptimeMs, ntpNowMs(), len, flags};
  size_t need = sizeof(h) + len;
  while (ringCap_ - ringUsed_ < need) {  // full: drop oldest
    popOldestLocked();
    dropped_++;
  }
  ringWrite(&h, sizeof(h));
  ringWrite(text, len);
  pendingLines_++;
}

void Sensor2Cloud::popOldestLocked() {
  RecordHeader h;
  ringRead(ringTail_, &h, sizeof(h));
  size_t size = sizeof(h) + h.len;
  ringTail_ = (ringTail_ + size) % ringCap_;
  ringUsed_ -= size;
  pendingLines_--;
}

// Server confirmed everything up to lastSeq. Pop by seq, not by count: the producer may
// have dropped some of those records itself while we were sending.
void Sensor2Cloud::ackUpTo(uint32_t lastSeq) {
  Lock lock(mutex_);
  while (ringUsed_ > 0) {
    RecordHeader h;
    ringRead(ringTail_, &h, sizeof(h));
    if (h.seq > lastSeq) break;
    popOldestLocked();
  }
}

void Sensor2Cloud::ringWrite(const void* src, size_t n) {
  const uint8_t* p = (const uint8_t*)src;
  size_t first = min(n, ringCap_ - ringHead_);
  memcpy(ring_ + ringHead_, p, first);
  memcpy(ring_, p + first, n - first);
  ringHead_ = (ringHead_ + n) % ringCap_;
  ringUsed_ += n;
}

size_t Sensor2Cloud::ringRead(size_t pos, void* dst, size_t n) const {
  uint8_t* p = (uint8_t*)dst;
  size_t first = min(n, ringCap_ - pos);
  memcpy(p, ring_ + pos, first);
  memcpy(p + first, ring_, n - first);
  return (pos + n) % ringCap_;
}

// Copies the oldest lines into scratch_ as [header][text]['\0'] so the lock is held only
// for a memcpy, not for the HTTP request.
size_t Sensor2Cloud::copyBatch(size_t& lineCount, uint32_t& lastSeq) {
  Lock lock(mutex_);
  size_t pos = ringTail_, left = ringUsed_, out = 0;
  lineCount = 0;
  while (left > 0 && lineCount < kMaxBatchLines) {
    RecordHeader h;
    size_t textPos = ringRead(pos, &h, sizeof(h));
    size_t entry = sizeof(h) + h.len + 1;
    if (out + entry > scratchCap_) break;
    memcpy(scratch_ + out, &h, sizeof(h));
    ringRead(textPos, scratch_ + out + sizeof(h), h.len);
    scratch_[out + sizeof(h) + h.len] = '\0';
    out += entry;
    pos = (textPos + h.len) % ringCap_;
    left -= sizeof(h) + h.len;
    lastSeq = h.seq;
    lineCount++;
  }
  return out;
}

// ------------------------------------------------------------------ network task

void Sensor2Cloud::taskEntry(void* self) { static_cast<Sensor2Cloud*>(self)->taskLoop(); }

void Sensor2Cloud::taskLoop() {
  uint32_t nextSendAt = millis() + intervalMs_;
  uint32_t backoffMs = 0;
  uint32_t lastWifiTry = millis();
  bool wasConnected = false;

  for (;;) {
    // Sleep up to 250 ms, or until write()/flush() pokes us.
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(250));
    uint32_t now = millis();
    flushStalePartial(now);

    bool up = WiFi.status() == WL_CONNECTED;
    if (up != wasConnected) {
      wasConnected = up;
      if (up) {
        log("wifi connected, ip=%s", WiFi.localIP().toString().c_str());
        nextSendAt = now;
        backoffMs = 0;
      } else {
        log("wifi disconnected");
      }
    }
    if (!up) {
      if (now - lastWifiTry >= kWifiRetryMs) {
        lastWifiTry = now;
        log("wifi retry (status %d)", (int)WiFi.status());
        WiFi.reconnect();
      }
      continue;
    }
    lastWifiTry = now;

    // We POST every interval even with no lines (a "check-in"): that is how commands reach
    // the node, and it keeps last_seen fresh on the server.
    size_t pending = queuedLines();
    bool due = reached(now, nextSendAt);
    bool early = backoffMs == 0 && (pending >= kMaxBatchLines || flushRequested_ || replyCount_ > 0);
    if (!due && !early) continue;
    flushRequested_ = false;

    SendResult r = sendBatch();
    now = millis();
    if (r == SendResult::Failed) {
      backoffMs = backoffMs == 0 ? intervalMs_ : min(backoffMs * 2, kMaxBackoffMs);
      nextSendAt = now + backoffMs;
    } else {
      backoffMs = 0;
      // Backlog (e.g. after an outage)? Keep draining. Otherwise wait a full interval.
      nextSendAt = queuedLines() >= kMaxBatchLines ? now : now + intervalMs_;
    }
  }
}

Sensor2Cloud::SendResult Sensor2Cloud::sendBatch() {
  size_t count = 0;
  uint32_t lastSeq = 0;
  size_t bytes = copyBatch(count, lastSeq);
  size_t replyCount = replyCount_;  // replies added while handling this response go in the next batch

  JsonDocument doc;
  doc["mac"] = mac_;
  if (name_.length()) doc["name"] = name_;
  doc["bootId"] = bootId_;
  JsonArray lines = doc["lines"].to<JsonArray>();
  for (size_t off = 0; off < bytes;) {
    RecordHeader h;
    memcpy(&h, scratch_ + off, sizeof(h));  // memcpy: header may be unaligned in the buffer
    char* text = (char*)(scratch_ + off + sizeof(h));
    JsonObject o = lines.add<JsonObject>();
    o["seq"] = h.seq;
    o["uptimeMs"] = h.uptimeMs;
    if (h.tsMs) o["ts"] = h.tsMs;
    o["text"] = text;  // non-const char* -> ArduinoJson copies it
    if (h.flags & kFlagIncomplete) o["incomplete"] = true;
    off += sizeof(h) + h.len + 1;
  }
  if (replyCount > 0) {
    JsonArray reps = doc["replies"].to<JsonArray>();
    for (size_t i = 0; i < replyCount; i++) {
      JsonObject o = reps.add<JsonObject>();
      o["id"] = replies_[i].id;
      o["ok"] = replies_[i].ok;
      o["text"] = replies_[i].text;
    }
  }
  doc["sentUptimeMs"] = millis();
  if (doc.overflowed()) {
    log("out of memory building batch, retrying later");
    return SendResult::Failed;
  }
  String body;
  serializeJson(doc, body);
  doc.clear();  // free the JSON tree before the HTTP request needs heap

  HTTPClient http;
  http.setConnectTimeout(kHttpTimeoutMs);
  http.setTimeout(kHttpTimeoutMs);
  if (!http.begin(url_)) {
    log("bad server url: %s", url_.c_str());
    return SendResult::Failed;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + deviceKey_);
  int code = http.POST(body);
  String resp = code > 0 ? http.getString() : String();
  http.end();

  // Removes the replies that were in this request (the first replyCount entries).
  auto dropSentReplies = [&]() {  // [&] = the lambda can use local variables by reference
    for (size_t i = replyCount; i < replyCount_; i++) replies_[i - replyCount] = replies_[i];
    replyCount_ -= replyCount;
  };

  if (code >= 200 && code < 300) {
    if (count > 0) ackUpTo(lastSeq);
    dropSentReplies();
    if (count > 0 || replyCount > 0) {
      log("sent %u lines (seq ..%u), %u replies -> %d", (unsigned)count, (unsigned)lastSeq,
          (unsigned)replyCount, code);
    }
    handleResponse(resp);
    return SendResult::Delivered;
  }
  if (code == 400 || code == 413) {
    // Retrying the same payload can never succeed, and would block everything behind it.
    if (count > 0) ackUpTo(lastSeq);
    dropSentReplies();
    log("server rejected %u lines (%d %s), dropped them", (unsigned)count, code, resp.c_str());
    return SendResult::Rejected;
  }
  if (code == 401) {
    log("server says device key is wrong (401), keeping lines");
  } else if (code < 0) {
    log("http error: %s", HTTPClient::errorToString(code).c_str());
  } else {
    log("server returned %d %s, will retry", code, resp.c_str());
  }
  return SendResult::Failed;
}

// ------------------------------------------------------------------ cloud commands

// The batch response may carry commands: { ..., "commands": [{ "id": 7, "cmd": "ping", "args": "" }] }
void Sensor2Cloud::handleResponse(const String& body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;  // not JSON (or old server): nothing to do
  for (JsonObject c : doc["commands"].as<JsonArray>()) {
    uint32_t id = c["id"] | 0;  // `| default` = ArduinoJson's "value or default if missing"
    const char* cmd = c["cmd"] | "";
    const char* args = c["args"] | "";
    if (id == 0 || id <= lastCommandId_) continue;  // already ran it, reply is on its way
    if (replyCount_ >= kMaxReplies) break;           // no room to answer; server will re-send later
    lastCommandId_ = id;
    runCommand(id, cmd, args);
  }
}

void Sensor2Cloud::runCommand(uint32_t id, const char* cmd, const char* args) {
  String reply;
  bool ok;
  if (strcmp(cmd, "ping") == 0) {
    ok = true;
    reply = "pong";
  } else if (strcmp(cmd, "status") == 0) {
    char buf[160];
    snprintf(buf, sizeof(buf), "uptime=%lu heap=%u queued=%u dropped=%u rssi=%d bootId=%u",
             (unsigned long)millis(), (unsigned)ESP.getFreeHeap(), (unsigned)queuedLines(),
             (unsigned)droppedLines(), (int)WiFi.RSSI(), (unsigned)bootId_);
    ok = true;
    reply = buf;
  } else if (commandHandler_) {
    ok = commandHandler_(cmd, args, reply);
  } else {
    ok = false;
    reply = "unknown command";
  }
  if (reply.length() > kMaxLineBytes) reply.remove(kMaxLineBytes);  // server limit
  log("command #%u %s(%s) -> %s %s", (unsigned)id, cmd, args, ok ? "ok" : "failed", reply.c_str());
  replies_[replyCount_++] = Reply{id, ok, reply};
}

// ------------------------------------------------------------------ debug log

// `...` + va_list = C-style varargs, the printf way of taking any number of arguments.
void Sensor2Cloud::log(const char* fmt, ...) {
  if (!debug_) return;
  char buf[256];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  debug_->print("[sensor2cloud] ");
  debug_->println(buf);
}
