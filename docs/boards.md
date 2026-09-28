# Board presets

Pass `board: "<id>"` to any render tool (`lvgl_render`, `lvgl_render_full`, `lvgl_render_project`,
`lvgl_render_ui`, `lvgl_interact`). The preset sets the display size, colour format, DPI, rotation
and the LVGL heap budget (`mem_budget_kb`, the board's typical `LV_MEM_SIZE`); explicit parameters
override it. The same data is available to MCP clients as the resource `lvgl://boards` and the
`lvgl_docs` topic `boards`.

Sizes are the orientation UIs are usually designed for (landscape for most panels). DPI is derived
from the panel diagonal. Monochrome OLEDs are rendered as RGB565 - design them in black and white.

<!-- BOARDS:BEGIN -->
| id | Board | Resolution | Color | DPI | Rotation | LV_MEM_SIZE | Panel | Notes |
|---|---|---|---|---|---|---|---|---|
| `esp32-2432s028r` | ESP32-2432S028R "Cheap Yellow Display" 2.8" | 320x240 | RGB565 | 143 | 0 | 48 KB | ILI9341 (SPI), XPT2046 resistive touch | ESP32-WROOM, no PSRAM: keep the LVGL heap small, 1/10-screen draw buffers. |
| `esp32-8048s070` | Sunton ESP32-8048S070 7" | 800x480 | RGB565 | 133 | 0 | 64 KB | 16-bit RGB parallel TFT, GT911 capacitive touch | ESP32-S3 with 8 MB PSRAM; framebuffers in PSRAM. |
| `wt32-sc01-plus` | Wireless-Tag WT32-SC01 Plus 3.5" | 480x320 | RGB565 | 165 | 0 | 64 KB | ST7796 (8-bit parallel), FT6336U capacitive touch | ESP32-S3 with 2 MB PSRAM. |
| `lilygo-t-display-s3` | LILYGO T-Display-S3 1.9" | 320x170 | RGB565 | 190 | 0 | 64 KB | ST7789 (8-bit parallel), optional touch | Native panel is 170x320 portrait; most UIs rotate to landscape. Two buttons, often no touch. |
| `lilygo-t-display` | LILYGO T-Display 1.14" | 135x240 | RGB565 | 241 | 0 | 48 KB | ST7789 (SPI) | Classic ESP32, no touch (two buttons): design for keypad/encoder navigation. |
| `m5stack-core2` | M5Stack Core2 2.0" | 320x240 | RGB565 | 200 | 0 | 64 KB | ILI9342C (SPI), FT6336U capacitive touch | ESP32 with 8 MB PSRAM; three touch buttons below the screen. |
| `m5stack-cores3` | M5Stack CoreS3 2.0" | 320x240 | RGB565 | 200 | 0 | 64 KB | ILI9342C (SPI), FT6336U capacitive touch | ESP32-S3 with 8 MB PSRAM. |
| `waveshare-esp32-s3-touch-lcd-1.28` | Waveshare ESP32-S3-Touch-LCD-1.28 (round) | 240x240 | RGB565 | 265 | 0 | 48 KB | GC9A01 round (SPI), CST816S capacitive touch | Round panel: the corners of the 240x240 square are not visible - keep content inside the circle. |
| `esp32-s3-box-3` | Espressif ESP32-S3-BOX-3 2.4" | 320x240 | RGB565 | 167 | 0 | 64 KB | ILI9342C (SPI), capacitive touch | ESP32-S3 with 16 MB flash / 16 MB PSRAM; esp_lvgl_port based BSP. |
| `esp32-c3-0.42-oled` | ESP32-C3 0.42" OLED dev board | 72x40 | RGB565 | 196 | 0 | 32 KB | SSD1306 72x40 monochrome (I2C) | Monochrome panel: rendered as RGB565 here - use only black/white and high contrast; no touch. |
| `ssd1306-128x64` | SSD1306 0.96" OLED 128x64 | 128x64 | RGB565 | 149 | 0 | 32 KB | SSD1306 monochrome (I2C/SPI) | Monochrome panel: rendered as RGB565 here - use only black/white, small fonts (unscii_8, montserrat_10); no touch. |
| `st7735-160x80` | ST7735 0.96" IPS 160x80 | 160x80 | RGB565 | 186 | 0 | 32 KB | ST7735S (SPI) | Tiny color panel, no touch. |
| `generic-320x240` | Generic 320x240 (QVGA) | 320x240 | RGB565 | 130 | 0 | 64 KB | any 2.4"-3.2" SPI panel (ILI9341, ST7789) | LVGL's default DPI. |
| `generic-480x320` | Generic 480x320 (HVGA) | 480x320 | RGB565 | 130 | 0 | 64 KB | any 3.5" panel (ILI9488, ST7796) | LVGL's default DPI. |
| `generic-800x480` | Generic 800x480 (WVGA) | 800x480 | RGB565 | 130 | 0 | 64 KB | any 4.3"-7" RGB parallel panel | LVGL's default DPI. |
<!-- BOARDS:END -->

This table is generated from `mcp-server/src/boards.ts` (the single source of truth):

```sh
node mcp-server/scripts/gen-boards-md.mjs --write            # updates this file
node mcp-server/scripts/gen-boards-md.mjs --write README.md  # any file with the BOARDS markers
node mcp-server/scripts/gen-boards-md.mjs --check            # CI: fail when out of date
```

Missing your board? Add an entry to `BOARDS` in `mcp-server/src/boards.ts` and regenerate.
