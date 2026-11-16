// The exact lines examples/hardware_test/main.cpp prints, in seq order (seq 0..182).
// Keep in sync with that sketch.

function expectedLines() {
  const lines = [];
  const add = (text, incomplete = false) => lines.push({ text, incomplete });

  add("hwtest start");
  for (let i = 0; i < 20; i++) add(`line i=${i}`);
  for (let i = 0; i < 150; i++) add(`burst i=${i}`);

  // 2500-byte line -> split at 1 KB, pieces before the last are incomplete
  const long = Array.from({ length: 2500 }, (_, i) => String(i % 10)).join("");
  add(long.slice(0, 1024), true);
  add(long.slice(1024, 2048), true);
  add(long.slice(2048));

  // é would straddle byte 1024 -> the cut moves back so é stays whole in the next piece
  add("a".repeat(1023), true);
  add("éend");

  add("utf8 é ü 温度 ✓");
  add("pieces a=1 b=2");
  add("");
  add("partial-no-newline", true); // no newline for > 5 s
  add("after partial");
  add("flushed-partial", true);    // cloud.flush() on unterminated text
  add("hwtest done");
  return lines;
}

module.exports = { expectedLines, NODE_NAME: "hwtest" };
