/**
 * Board presets (contract section 8): the single source of truth for the
 * `board` render parameter, the lvgl://boards resource, the lvgl_docs
 * "boards" topic and the README / docs/boards.md table
 * (scripts/gen-boards-md.mjs).
 *
 * width/height are the orientation UIs are usually designed for (landscape
 * for most panels); dpi is derived from the panel diagonal; mem_kb is a
 * typical LV_MEM_SIZE for that board's LVGL port (the render reports
 * MEM_OVER_BUDGET when the UI's LVGL heap peak exceeds it).
 */
import type { ColorFormat, Rotation } from "./simulator/types.js";

export interface BoardPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  color_format: ColorFormat;
  dpi: number;
  rotation: Rotation;
  /** Typical LV_MEM_SIZE in KB. */
  mem_kb: number;
  /** Display controller / panel. */
  panel: string;
  notes: string;
}

export const BOARDS: readonly BoardPreset[] = [
  {
    id: "esp32-2432s028r",
    name: "ESP32-2432S028R \"Cheap Yellow Display\" 2.8\"",
    width: 320,
    height: 240,
    color_format: "rgb565",
    dpi: 143,
    rotation: 0,
    mem_kb: 48,
    panel: "ILI9341 (SPI), XPT2046 resistive touch",
    notes: "ESP32-WROOM, no PSRAM: keep the LVGL heap small, 1/10-screen draw buffers.",
  },
  {
    id: "esp32-8048s070",
    name: "Sunton ESP32-8048S070 7\"",
    width: 800,
    height: 480,
    color_format: "rgb565",
    dpi: 133,
    rotation: 0,
    mem_kb: 64,
    panel: "16-bit RGB parallel TFT, GT911 capacitive touch",
    notes: "ESP32-S3 with 8 MB PSRAM; framebuffers in PSRAM.",
  },
  {
    id: "wt32-sc01-plus",
    name: "Wireless-Tag WT32-SC01 Plus 3.5\"",
    width: 480,
    height: 320,
    color_format: "rgb565",
    dpi: 165,
    rotation: 0,
    mem_kb: 64,
    panel: "ST7796 (8-bit parallel), FT6336U capacitive touch",
    notes: "ESP32-S3 with 2 MB PSRAM.",
  },
  {
    id: "lilygo-t-display-s3",
    name: "LILYGO T-Display-S3 1.9\"",
    width: 320,
    height: 170,
    color_format: "rgb565",
    dpi: 190,
    rotation: 0,
    mem_kb: 64,
    panel: "ST7789 (8-bit parallel), optional touch",
    notes: "Native panel is 170x320 portrait; most UIs rotate to landscape. Two buttons, often no touch.",
  },
  {
    id: "lilygo-t-display",
    name: "LILYGO T-Display 1.14\"",
    width: 135,
    height: 240,
    color_format: "rgb565",
    dpi: 241,
    rotation: 0,
    mem_kb: 48,
    panel: "ST7789 (SPI)",
    notes: "Classic ESP32, no touch (two buttons): design for keypad/encoder navigation.",
  },
  {
    id: "m5stack-core2",
    name: "M5Stack Core2 2.0\"",
    width: 320,
    height: 240,
    color_format: "rgb565",
    dpi: 200,
    rotation: 0,
    mem_kb: 64,
    panel: "ILI9342C (SPI), FT6336U capacitive touch",
    notes: "ESP32 with 8 MB PSRAM; three touch buttons below the screen.",
  },
  {
    id: "m5stack-cores3",
    name: "M5Stack CoreS3 2.0\"",
    width: 320,
    height: 240,
    color_format: "rgb565",
    dpi: 200,
    rotation: 0,
    mem_kb: 64,
    panel: "ILI9342C (SPI), FT6336U capacitive touch",
    notes: "ESP32-S3 with 8 MB PSRAM.",
  },
  {
    id: "waveshare-esp32-s3-touch-lcd-1.28",
    name: "Waveshare ESP32-S3-Touch-LCD-1.28 (round)",
    width: 240,
    height: 240,
    color_format: "rgb565",
    dpi: 265,
    rotation: 0,
    mem_kb: 48,
    panel: "GC9A01 round (SPI), CST816S capacitive touch",
    notes: "Round panel: the corners of the 240x240 square are not visible - keep content inside the circle.",
  },
  {
    id: "esp32-s3-box-3",
    name: "Espressif ESP32-S3-BOX-3 2.4\"",
    width: 320,
    height: 240,
    color_format: "rgb565",
    dpi: 167,
    rotation: 0,
    mem_kb: 64,
    panel: "ILI9342C (SPI), capacitive touch",
    notes: "ESP32-S3 with 16 MB flash / 16 MB PSRAM; esp_lvgl_port based BSP.",
  },
  {
    id: "esp32-c3-0.42-oled",
    name: "ESP32-C3 0.42\" OLED dev board",
    width: 72,
    height: 40,
    color_format: "rgb565",
    dpi: 196,
    rotation: 0,
    mem_kb: 32,
    panel: "SSD1306 72x40 monochrome (I2C)",
    notes: "Monochrome panel: rendered as RGB565 here - use only black/white and high contrast; no touch.",
  },
  {
    id: "ssd1306-128x64",
    name: "SSD1306 0.96\" OLED 128x64",
    width: 128,
    height: 64,
    color_format: "rgb565",
    dpi: 149,
    rotation: 0,
    mem_kb: 32,
    panel: "SSD1306 monochrome (I2C/SPI)",
    notes: "Monochrome panel: rendered as RGB565 here - use only black/white, small fonts (unscii_8, montserrat_10); no touch.",
  },
  {
    id: "st7735-160x80",
    name: "ST7735 0.96\" IPS 160x80",
    width: 160,
    height: 80,
    color_format: "rgb565",
    dpi: 186,
    rotation: 0,
    mem_kb: 32,
    panel: "ST7735S (SPI)",
    notes: "Tiny color panel, no touch.",
  },
  {
    id: "generic-320x240",
    name: "Generic 320x240 (QVGA)",
    width: 320,
    height: 240,
    color_format: "rgb565",
    dpi: 130,
    rotation: 0,
    mem_kb: 64,
    panel: "any 2.4\"-3.2\" SPI panel (ILI9341, ST7789)",
    notes: "LVGL's default DPI.",
  },
  {
    id: "generic-480x320",
    name: "Generic 480x320 (HVGA)",
    width: 480,
    height: 320,
    color_format: "rgb565",
    dpi: 130,
    rotation: 0,
    mem_kb: 64,
    panel: "any 3.5\" panel (ILI9488, ST7796)",
    notes: "LVGL's default DPI.",
  },
  {
    id: "generic-800x480",
    name: "Generic 800x480 (WVGA)",
    width: 800,
    height: 480,
    color_format: "rgb565",
    dpi: 130,
    rotation: 0,
    mem_kb: 64,
    panel: "any 4.3\"-7\" RGB parallel panel",
    notes: "LVGL's default DPI.",
  },
];

export const BOARD_IDS = BOARDS.map((b) => b.id) as [string, ...string[]];

export function findBoard(id: string): BoardPreset | undefined {
  return BOARDS.find((b) => b.id === id);
}

/** The render parameters a board sets (explicit parameters override them). */
export interface BoardDefaults {
  width: number;
  height: number;
  colorFormat: ColorFormat;
  dpi: number;
  rotation: Rotation;
  memBudgetKb: number;
}

export function boardDefaults(id: string | undefined): BoardDefaults | undefined {
  if (!id) return undefined;
  const b = findBoard(id);
  if (!b) throw new Error(`Unknown board "${id}". Known boards: ${BOARD_IDS.join(", ")}`);
  return {
    width: b.width,
    height: b.height,
    colorFormat: b.color_format,
    dpi: b.dpi,
    rotation: b.rotation,
    memBudgetKb: b.mem_kb,
  };
}

/** Markdown table of all boards (README, docs/boards.md, lvgl_docs "boards"). */
export function boardsMarkdownTable(): string {
  const rows = [
    "| id | Board | Resolution | Color | DPI | Rotation | LV_MEM_SIZE | Panel | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const b of BOARDS) {
    rows.push(
      `| \`${b.id}\` | ${b.name.replace(/\|/g, "\\|")} | ${b.width}x${b.height} | ${b.color_format.toUpperCase()} | ${b.dpi} | ${b.rotation} | ${b.mem_kb} KB | ${b.panel} | ${b.notes} |`
    );
  }
  return rows.join("\n");
}
