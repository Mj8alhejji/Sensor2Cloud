// Sensor2Cloud - print lines on an ESP32, read them in the cloud.
//
//   Sensor2Cloud cloud("wifi", "password", "device-key");
//   cloud.server("http://192.168.1.50:8080");
//   cloud.begin();               // non-blocking
//   cloud.println("temp=24.5");  // buffered, sent in the background
//
// All parsing happens server-side. The firmware only ships raw lines.
#pragma once

#include <Arduino.h>
#include <atomic>
#include <functional>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

// Inheriting from Arduino's Print class (like Serial does) gives us every
// print()/println()/printf() overload for free. We only implement write().
class Sensor2Cloud : public Print {
 public:
  // Handler for cloud commands the library does not handle itself ("ping" and "status" are built in).
  // Write the answer into `reply` and return true for success, false for failure.
  // Runs on the network task (core 0): keep it short, and hand slow work to loop() with a flag.
  // std::function = like a Java functional interface; accepts plain functions and lambdas.
  using CommandHandler = std::function<bool(const char* cmd, const char* args, String& reply)>;

  Sensor2Cloud(const char* wifiSsid, const char* wifiPassword, const char* deviceKey);

  // ---- settings: call these before begin() ----
  void server(const char* baseUrl);    // e.g. "http://192.168.1.50:8080" (no trailing path)
  void nodeName(const char* name);     // optional display label, max 64 chars. Server falls back to MAC.
  void sendInterval(uint32_t ms);      // default 5000. A batch also goes out early at 100 queued lines.
  void debug(Print& out);              // opt-in library log output, e.g. cloud.debug(Serial)
  void onCommand(CommandHandler handler);  // optional: handle custom cloud commands (e.g. "blink")

  // Allocates the RAM buffer, starts WiFi and the background task, returns immediately.
  // Returns false if server() is missing or memory could not be allocated.
  // Lines printed before begin() are dropped.
  bool begin(size_t bufferBytes = 16 * 1024);

  // ---- Print interface ----
  size_t write(uint8_t b) override;
  size_t write(const uint8_t* data, size_t len) override;
  using Print::write;  // overriding write() hides Print's other write() overloads; this un-hides them
  void flush() override;  // commits any unterminated text (as incomplete) and sends as soon as possible

  // ---- status ----
  bool connected() const;
  size_t queuedLines() const;  // lines in RAM, not yet acknowledged by the server
  uint32_t droppedLines() const;  // lines lost because the buffer was full (oldest dropped first)

  // Not copyable: the background task holds a pointer to this object.
  Sensor2Cloud(const Sensor2Cloud&) = delete;
  Sensor2Cloud& operator=(const Sensor2Cloud&) = delete;

 private:
  enum class SendResult { Delivered, Rejected, Failed };

  // FreeRTOS wants a plain C function, so a static function receives `this` as void* and forwards.
  static void taskEntry(void* self);
  void taskLoop();
  SendResult sendBatch();

  // Everything below "Locked" must only be called while holding mutex_.
  void commitLineLocked(uint8_t flags, uint32_t now);
  void splitFullLineLocked(uint8_t nextByte, uint32_t now);
  void pushRecordLocked(const uint8_t* text, uint16_t len, uint8_t flags, uint32_t uptimeMs);
  void popOldestLocked();
  void ackUpTo(uint32_t lastSeq);
  void flushStalePartial(uint32_t now);
  size_t copyBatch(size_t& lineCount, uint32_t& lastSeq);

  void ringWrite(const void* src, size_t n);
  size_t ringRead(size_t pos, void* dst, size_t n) const;

  void handleResponse(const String& body);
  void runCommand(uint32_t id, const char* cmd, const char* args);

  void log(const char* fmt, ...);

  // Command replies waiting to ride along with the next batch. Only the network task touches these.
  struct Reply {
    uint32_t id;
    bool ok;
    String text;
  };
  static constexpr size_t kMaxReplies = 8;
  Reply replies_[kMaxReplies];
  size_t replyCount_ = 0;
  uint32_t lastCommandId_ = 0;  // server re-delivers unanswered commands; skip ones we already ran
  CommandHandler commandHandler_;

  // config
  String ssid_, password_, deviceKey_, url_, name_, mac_;
  uint32_t intervalMs_ = 5000;
  Print* debug_ = nullptr;

  // runtime
  uint32_t bootId_ = 0;
  TaskHandle_t task_ = nullptr;
  SemaphoreHandle_t mutex_ = nullptr;  // guards everything below
  std::atomic<bool> flushRequested_{false};

  // byte ring of [RecordHeader][text] records
  uint8_t* ring_ = nullptr;
  size_t ringCap_ = 0, ringHead_ = 0, ringTail_ = 0, ringUsed_ = 0;
  size_t pendingLines_ = 0;
  uint32_t dropped_ = 0;
  uint32_t nextSeq_ = 0;

  // line being assembled from print() calls
  uint8_t* line_ = nullptr;
  size_t lineLen_ = 0;
  bool lineOpen_ = false;
  uint32_t lineStartMs_ = 0;
  uint32_t lastWriteMs_ = 0;

  // copy of one batch, taken under the lock, sent without it
  uint8_t* scratch_ = nullptr;
  size_t scratchCap_ = 0;
};
