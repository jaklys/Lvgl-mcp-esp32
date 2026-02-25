import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SimulatorManager } from "../simulator/manager.js";

const LVGL_API_CHEATSHEET = `# LVGL 9.2 API Quick Reference

## Screen & Display
\`\`\`c
lv_obj_t *screen = lv_screen_active();      // Get active screen
lv_display_t *disp = lv_display_get_default(); // Get default display
\`\`\`

## Widget Creation (all return lv_obj_t*)
\`\`\`c
lv_obj_t *obj = lv_obj_create(parent);           // Base object / container
lv_obj_t *btn = lv_button_create(parent);         // Button
lv_obj_t *lbl = lv_label_create(parent);          // Label
lv_obj_t *slider = lv_slider_create(parent);      // Slider
lv_obj_t *bar = lv_bar_create(parent);            // Progress bar
lv_obj_t *sw = lv_switch_create(parent);          // Toggle switch
lv_obj_t *cb = lv_checkbox_create(parent);        // Checkbox
lv_obj_t *dd = lv_dropdown_create(parent);        // Dropdown
lv_obj_t *ta = lv_textarea_create(parent);        // Text area
lv_obj_t *arc = lv_arc_create(parent);            // Arc
lv_obj_t *chart = lv_chart_create(parent);        // Chart
lv_obj_t *roller = lv_roller_create(parent);      // Roller
lv_obj_t *tab = lv_tabview_create(parent);        // Tab view
lv_obj_t *list = lv_list_create(parent);          // List
lv_obj_t *led = lv_led_create(parent);            // LED indicator
lv_obj_t *spinner = lv_spinner_create(parent);    // Spinner
lv_obj_t *table = lv_table_create(parent);        // Table
lv_obj_t *keyboard = lv_keyboard_create(parent);  // On-screen keyboard
lv_obj_t *calendar = lv_calendar_create(parent);  // Calendar
lv_obj_t *menu = lv_menu_create(parent);          // Menu
lv_obj_t *win = lv_win_create(parent);            // Window
lv_obj_t *msgbox = lv_msgbox_create(parent);      // Message box
lv_obj_t *spinbox = lv_spinbox_create(parent);    // Spinbox
lv_obj_t *canvas = lv_canvas_create(parent);      // Canvas
lv_obj_t *img = lv_image_create(parent);          // Image
lv_obj_t *line = lv_line_create(parent);          // Line
lv_obj_t *scale = lv_scale_create(parent);        // Scale
\`\`\`

## Size & Position
\`\`\`c
lv_obj_set_size(obj, w, h);
lv_obj_set_width(obj, w);
lv_obj_set_height(obj, h);
lv_obj_set_pos(obj, x, y);
lv_obj_set_x(obj, x);
lv_obj_set_y(obj, y);
lv_obj_center(obj);                              // Center in parent
lv_obj_align(obj, LV_ALIGN_CENTER, x_ofs, y_ofs);
lv_obj_align_to(obj, ref, LV_ALIGN_OUT_BOTTOM_MID, x_ofs, y_ofs);
lv_obj_set_content_width(obj, w);
lv_obj_set_content_height(obj, h);

// Size constants
LV_SIZE_CONTENT    // Auto-size to content
LV_PCT(50)         // 50% of parent
\`\`\`

## Alignment Constants
\`\`\`
LV_ALIGN_DEFAULT, LV_ALIGN_TOP_LEFT, LV_ALIGN_TOP_MID, LV_ALIGN_TOP_RIGHT,
LV_ALIGN_BOTTOM_LEFT, LV_ALIGN_BOTTOM_MID, LV_ALIGN_BOTTOM_RIGHT,
LV_ALIGN_LEFT_MID, LV_ALIGN_RIGHT_MID, LV_ALIGN_CENTER,
LV_ALIGN_OUT_TOP_LEFT, LV_ALIGN_OUT_TOP_MID, LV_ALIGN_OUT_TOP_RIGHT,
LV_ALIGN_OUT_BOTTOM_LEFT, LV_ALIGN_OUT_BOTTOM_MID, LV_ALIGN_OUT_BOTTOM_RIGHT,
LV_ALIGN_OUT_LEFT_TOP, LV_ALIGN_OUT_LEFT_MID, LV_ALIGN_OUT_LEFT_BOTTOM,
LV_ALIGN_OUT_RIGHT_TOP, LV_ALIGN_OUT_RIGHT_MID, LV_ALIGN_OUT_RIGHT_BOTTOM
\`\`\`

## Flex Layout
\`\`\`c
lv_obj_set_flex_flow(obj, LV_FLEX_FLOW_ROW);       // ROW, COLUMN, ROW_WRAP, COLUMN_WRAP, ROW_REVERSE, COLUMN_REVERSE
lv_obj_set_flex_align(obj,
    LV_FLEX_ALIGN_START,    // main axis: START, END, CENTER, SPACE_BETWEEN, SPACE_AROUND, SPACE_EVENLY
    LV_FLEX_ALIGN_CENTER,   // cross axis
    LV_FLEX_ALIGN_CENTER);  // track cross
lv_obj_set_flex_grow(child, 1);                     // Flex grow factor
\`\`\`

## Grid Layout
\`\`\`c
static int32_t col_dsc[] = {100, 200, LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST};
static int32_t row_dsc[] = {50, LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST};
lv_obj_set_grid_dsc_array(obj, col_dsc, row_dsc);
lv_obj_set_grid_cell(child, LV_GRID_ALIGN_STRETCH, col, col_span,
                     LV_GRID_ALIGN_STRETCH, row, row_span);
\`\`\`

## Styling
\`\`\`c
// Direct style setters (applied to default part + state)
lv_obj_set_style_bg_color(obj, lv_color_hex(0x003a57), LV_PART_MAIN);
lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
lv_obj_set_style_text_color(obj, lv_color_white(), 0);
lv_obj_set_style_text_font(obj, &lv_font_montserrat_20, 0);
lv_obj_set_style_border_width(obj, 2, 0);
lv_obj_set_style_border_color(obj, lv_color_hex(0x0), 0);
lv_obj_set_style_radius(obj, 8, 0);
lv_obj_set_style_pad_all(obj, 10, 0);
lv_obj_set_style_pad_left(obj, 10, 0);
lv_obj_set_style_pad_gap(obj, 5, 0);              // Gap between children
lv_obj_set_style_shadow_width(obj, 10, 0);
lv_obj_set_style_shadow_color(obj, lv_color_hex(0x0), 0);
lv_obj_set_style_opa(obj, LV_OPA_50, 0);

// Style objects (reusable)
static lv_style_t style;
lv_style_init(&style);
lv_style_set_bg_color(&style, lv_color_hex(0x003a57));
lv_obj_add_style(obj, &style, LV_PART_MAIN | LV_STATE_DEFAULT);
\`\`\`

## Colors
\`\`\`c
lv_color_hex(0xFF0000)          // Red from hex
lv_color_make(r, g, b)          // From RGB components
lv_color_white()                // White
lv_color_black()                // Black
lv_palette_main(LV_PALETTE_BLUE)   // Material palette color
lv_palette_lighten(LV_PALETTE_BLUE, 2)  // Lighter variant
lv_palette_darken(LV_PALETTE_BLUE, 2)   // Darker variant
\`\`\`

## Palette Names
\`\`\`
LV_PALETTE_RED, LV_PALETTE_PINK, LV_PALETTE_PURPLE, LV_PALETTE_DEEP_PURPLE,
LV_PALETTE_INDIGO, LV_PALETTE_BLUE, LV_PALETTE_LIGHT_BLUE, LV_PALETTE_CYAN,
LV_PALETTE_TEAL, LV_PALETTE_GREEN, LV_PALETTE_LIGHT_GREEN, LV_PALETTE_LIME,
LV_PALETTE_YELLOW, LV_PALETTE_AMBER, LV_PALETTE_ORANGE, LV_PALETTE_DEEP_ORANGE,
LV_PALETTE_BROWN, LV_PALETTE_BLUE_GREY, LV_PALETTE_GREY
\`\`\`

## Parts & States (for style selectors)
\`\`\`
Parts: LV_PART_MAIN, LV_PART_SCROLLBAR, LV_PART_INDICATOR,
       LV_PART_KNOB, LV_PART_SELECTED, LV_PART_ITEMS,
       LV_PART_CURSOR, LV_PART_CUSTOM_FIRST

States: LV_STATE_DEFAULT, LV_STATE_CHECKED, LV_STATE_FOCUSED,
        LV_STATE_FOCUS_KEY, LV_STATE_EDITED, LV_STATE_HOVERED,
        LV_STATE_PRESSED, LV_STATE_SCROLLED, LV_STATE_DISABLED
\`\`\`

## Common Widget APIs
\`\`\`c
// Label
lv_label_set_text(label, "Hello");
lv_label_set_text_fmt(label, "Value: %d", val);
lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);  // WRAP, SCROLL, DOT, CLIP

// Button - just a styled container, add a label child for text

// Slider / Bar
lv_slider_set_value(slider, 50, LV_ANIM_ON);
lv_slider_set_range(slider, 0, 100);
lv_bar_set_value(bar, 75, LV_ANIM_ON);
lv_bar_set_range(bar, 0, 100);

// Switch / Checkbox
lv_obj_add_state(sw, LV_STATE_CHECKED);     // Turn on
lv_obj_remove_state(sw, LV_STATE_CHECKED);  // Turn off
lv_checkbox_set_text(cb, "Option");

// Dropdown
lv_dropdown_set_options(dd, "Option 1\\nOption 2\\nOption 3");
lv_dropdown_set_selected(dd, 1);

// Text Area
lv_textarea_set_text(ta, "Hello");
lv_textarea_set_placeholder_text(ta, "Type here...");
lv_textarea_set_one_line(ta, true);

// Table
lv_table_set_cell_value(table, row, col, "text");
lv_table_set_column_count(table, 3);
lv_table_set_column_width(table, col, width);

// Chart
lv_chart_set_type(chart, LV_CHART_TYPE_LINE);
lv_chart_series_t *ser = lv_chart_add_series(chart, lv_palette_main(LV_PALETTE_RED), LV_CHART_AXIS_PRIMARY_Y);
lv_chart_set_next_value(chart, ser, value);
lv_chart_set_range(chart, LV_CHART_AXIS_PRIMARY_Y, 0, 100);

// Arc
lv_arc_set_value(arc, 50);
lv_arc_set_range(arc, 0, 100);

// LED
lv_led_on(led);
lv_led_off(led);
lv_led_set_color(led, lv_palette_main(LV_PALETTE_GREEN));

// List
lv_obj_t *btn = lv_list_add_button(list, LV_SYMBOL_FILE, "Item text");
lv_list_add_text(list, "Section header");
\`\`\`

## Fonts (available in this simulator)
\`\`\`
&lv_font_montserrat_12
&lv_font_montserrat_14  (default)
&lv_font_montserrat_16
&lv_font_montserrat_20
&lv_font_montserrat_24
\`\`\`

## Symbols (built-in icons)
\`\`\`
LV_SYMBOL_AUDIO, LV_SYMBOL_VIDEO, LV_SYMBOL_LIST, LV_SYMBOL_OK,
LV_SYMBOL_CLOSE, LV_SYMBOL_POWER, LV_SYMBOL_SETTINGS, LV_SYMBOL_HOME,
LV_SYMBOL_DOWNLOAD, LV_SYMBOL_DRIVE, LV_SYMBOL_REFRESH, LV_SYMBOL_MUTE,
LV_SYMBOL_VOLUME_MID, LV_SYMBOL_VOLUME_MAX, LV_SYMBOL_IMAGE, LV_SYMBOL_TINT,
LV_SYMBOL_PREV, LV_SYMBOL_PLAY, LV_SYMBOL_PAUSE, LV_SYMBOL_STOP,
LV_SYMBOL_NEXT, LV_SYMBOL_EJECT, LV_SYMBOL_LEFT, LV_SYMBOL_RIGHT,
LV_SYMBOL_PLUS, LV_SYMBOL_MINUS, LV_SYMBOL_EYE_OPEN, LV_SYMBOL_EYE_CLOSE,
LV_SYMBOL_WARNING, LV_SYMBOL_SHUFFLE, LV_SYMBOL_UP, LV_SYMBOL_DOWN,
LV_SYMBOL_LOOP, LV_SYMBOL_DIRECTORY, LV_SYMBOL_UPLOAD, LV_SYMBOL_CALL,
LV_SYMBOL_CUT, LV_SYMBOL_COPY, LV_SYMBOL_SAVE, LV_SYMBOL_BARS,
LV_SYMBOL_ENVELOPE, LV_SYMBOL_CHARGE, LV_SYMBOL_PASTE, LV_SYMBOL_BELL,
LV_SYMBOL_KEYBOARD, LV_SYMBOL_GPS, LV_SYMBOL_FILE, LV_SYMBOL_WIFI,
LV_SYMBOL_BATTERY_FULL, LV_SYMBOL_BATTERY_3, LV_SYMBOL_BATTERY_2,
LV_SYMBOL_BATTERY_1, LV_SYMBOL_BATTERY_EMPTY, LV_SYMBOL_USB,
LV_SYMBOL_BLUETOOTH, LV_SYMBOL_TRASH, LV_SYMBOL_EDIT, LV_SYMBOL_BACKSPACE,
LV_SYMBOL_SD_CARD, LV_SYMBOL_NEW_LINE
\`\`\`

## Scrolling & Overflow
\`\`\`c
lv_obj_set_scrollbar_mode(obj, LV_SCROLLBAR_MODE_OFF);  // OFF, ON, ACTIVE, AUTO
lv_obj_add_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
\`\`\`

## Flags
\`\`\`c
lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
lv_obj_add_flag(obj, LV_OBJ_FLAG_CLICKABLE);
lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
\`\`\`
`;

export function registerResources(
  server: McpServer,
  manager: SimulatorManager
): void {
  server.resource(
    "api-reference",
    "lvgl://api-reference",
    {
      description: "LVGL 9.2 API quick reference — widgets, styles, layouts, colors",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: LVGL_API_CHEATSHEET,
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.resource(
    "project-config",
    "lvgl://project-config",
    {
      description: "Current LVGL simulator configuration (resolution, version, color depth)",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(manager.getConfig(), null, 2),
          mimeType: "application/json",
        },
      ],
    })
  );
}
