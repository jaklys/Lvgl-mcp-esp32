/**
 * LVGL 9.6 reference text, split into lvgl_docs topics. The api-reference
 * resource is the concatenation of the topics (see ./index.ts).
 */

export const WIDGETS_OVERVIEW = `# Widgets overview (LVGL 9.6)

Per-widget pages with every public function: lvgl_docs topic "widgets/<name>" (e.g. "widgets/label").

## Screen & display
\`\`\`c
lv_obj_t *scr = lv_screen_active();
lv_display_t *disp = lv_display_get_default();
int32_t w = lv_display_get_horizontal_resolution(disp);
lv_obj_t *top = lv_layer_top();              // overlays (dialogs, toasts)
lv_obj_t *s2 = lv_obj_create(NULL);          // a new screen
lv_screen_load(s2);
\`\`\`

## Widgets (all return lv_obj_t*)
\`\`\`c
lv_obj_create(parent);        lv_button_create(parent);     lv_label_create(parent);
lv_image_create(parent);      lv_line_create(parent);       lv_arc_create(parent);
lv_bar_create(parent);        lv_slider_create(parent);     lv_switch_create(parent);
lv_checkbox_create(parent);   lv_dropdown_create(parent);   lv_roller_create(parent);
lv_textarea_create(parent);   lv_keyboard_create(parent);   lv_spinbox_create(parent);
lv_spinner_create(parent);    lv_led_create(parent);        lv_table_create(parent);
lv_chart_create(parent);      lv_scale_create(parent);      lv_calendar_create(parent);
lv_tabview_create(parent);    lv_tileview_create(parent);   lv_msgbox_create(parent);
lv_buttonmatrix_create(parent); lv_imagebutton_create(parent); lv_spangroup_create(parent);
lv_animimg_create(parent);    lv_canvas_create(parent);     lv_arclabel_create(parent);
lv_qrcode_create(parent);     lv_barcode_create(parent);
// deprecated in 9.6 (still work): lv_list_create, lv_menu_create, lv_win_create
\`\`\`

## Common widget APIs
\`\`\`c
// Label
lv_label_set_text(lbl, "Hello");  lv_label_set_text_fmt(lbl, "%d °C", t);  lv_label_set_text_static(lbl, str);
lv_label_set_long_mode(lbl, LV_LABEL_LONG_MODE_WRAP);  // _WRAP, _DOTS, _SCROLL, _SCROLL_CIRCULAR, _CLIP
lv_label_set_max_lines(lbl, 2);                          // [9.6+]
// Button: a container - put a label inside
lv_obj_t *btn = lv_button_create(scr); lv_obj_t *bl = lv_label_create(btn); lv_label_set_text(bl, "OK"); lv_obj_center(bl);
// Slider / bar / arc
lv_slider_set_range(s, 0, 100); lv_slider_set_value(s, 40, LV_ANIM_OFF);
lv_bar_set_range(b, 0, 100);    lv_bar_set_value(b, 75, LV_ANIM_OFF);
lv_arc_set_range(a, 0, 100);    lv_arc_set_value(a, 30);  lv_arc_set_bg_angles(a, 135, 45);  lv_arc_set_rotation(a, 0);
// Switch / checkbox (checked = LV_STATE_CHECKED)
lv_obj_add_state(sw, LV_STATE_CHECKED);   lv_checkbox_set_text(cb, "Enable");
// Dropdown / roller
lv_dropdown_set_options(dd, "One\\nTwo\\nThree");  lv_dropdown_set_selected(dd, 1);
lv_roller_set_options(r, "1\\n2\\n3", LV_ROLLER_MODE_NORMAL);  lv_roller_set_visible_row_count(r, 3);
// Textarea + keyboard
lv_textarea_set_placeholder_text(ta, "SSID");  lv_textarea_set_one_line(ta, true);  lv_textarea_set_password_mode(ta, true);
lv_keyboard_set_textarea(kb, ta);
// Spinner / LED
lv_spinner_set_anim_params(sp, 1000, 60);  lv_led_set_color(led, lv_palette_main(LV_PALETTE_GREEN)); lv_led_on(led);
// Table
lv_table_set_column_count(t, 2); lv_table_set_row_count(t, 3); lv_table_set_column_width(t, 0, 120);
lv_table_set_cell_value(t, 0, 0, "Name");
// Chart
lv_chart_set_type(ch, LV_CHART_TYPE_LINE);   // LINE, BAR, SCATTER
lv_chart_set_point_count(ch, 20);
lv_chart_set_axis_range(ch, LV_CHART_AXIS_PRIMARY_Y, 0, 100);
lv_chart_series_t *ser = lv_chart_add_series(ch, lv_palette_main(LV_PALETTE_RED), LV_CHART_AXIS_PRIMARY_Y);
lv_chart_set_next_value(ch, ser, 42);  lv_chart_refresh(ch);
// Scale (replaces v8 lv_meter)
lv_scale_set_mode(sc, LV_SCALE_MODE_ROUND_INNER);  lv_scale_set_range(sc, 0, 100);
lv_scale_set_total_tick_count(sc, 21); lv_scale_set_major_tick_every(sc, 5); lv_scale_set_label_show(sc, true);
// Tabview
lv_obj_t *tv = lv_tabview_create(scr); lv_tabview_set_tab_bar_position(tv, LV_DIR_TOP); lv_tabview_set_tab_bar_size(tv, 40);
lv_obj_t *tab1 = lv_tabview_add_tab(tv, "Home");
// Message box
lv_obj_t *mb = lv_msgbox_create(NULL);   // NULL = modal on the top layer
lv_msgbox_add_title(mb, "Warning"); lv_msgbox_add_text(mb, "Overheat!");
lv_msgbox_add_footer_button(mb, "OK"); lv_msgbox_add_close_button(mb);
// Image
lv_image_set_src(img, &my_img);  lv_image_set_scale(img, 512 /* 256 = 100% */);  lv_image_set_rotation(img, 450 /* 0.1 deg */);
// Line
static lv_point_precise_t pts[] = {{0, 0}, {50, 20}, {100, 0}};
lv_line_set_points(line, pts, 3);
\`\`\`

### Button matrix, image button, span, tileview, animimg
\`\`\`c
static const char *map[] = {"1", "2", "3", "\\n", "4", "5", "6", ""};   // "" terminates, "\\n" = new row
lv_obj_t *bm = lv_buttonmatrix_create(scr);  lv_buttonmatrix_set_map(bm, map);
lv_buttonmatrix_set_button_ctrl(bm, 0, LV_BUTTONMATRIX_CTRL_CHECKED);

lv_obj_t *ib = lv_imagebutton_create(scr);
lv_imagebutton_set_src(ib, LV_IMAGEBUTTON_STATE_RELEASED, &left_img, &mid_img, &right_img);

lv_obj_t *sg = lv_spangroup_create(scr);                 // rich text
lv_span_t *sp = lv_spangroup_add_span(sg);
lv_span_set_text(sp, "Hot ");  lv_style_set_text_color(lv_span_get_style(sp), lv_palette_main(LV_PALETTE_RED));

lv_obj_t *tv = lv_tileview_create(scr);                  // swipeable pages
lv_obj_t *t1 = lv_tileview_add_tile(tv, 0, 0, LV_DIR_RIGHT);
lv_obj_t *t2 = lv_tileview_add_tile(tv, 1, 0, LV_DIR_LEFT);

static const void *frames[] = {&frame1, &frame2, &frame3};
lv_obj_t *ai = lv_animimg_create(scr);
lv_animimg_set_src(ai, frames, 3); lv_animimg_set_duration(ai, 600); lv_animimg_set_repeat_count(ai, LV_ANIM_REPEAT_INFINITE); lv_animimg_start(ai);
\`\`\`

## Flags, states and scrolling
\`\`\`c
// Works on 9.5 and 9.6 (deprecated in 9.6, compile warning):
lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);        lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
// [9.6+] replacements:
lv_obj_set_hidden(obj, true);   lv_obj_set_scrollable(obj, false);   lv_obj_set_clickable(obj, true);
lv_obj_set_checkable(obj, true); lv_obj_set_checked(obj, true);      lv_obj_set_disabled(obj, true);
bool h = lv_obj_is_hidden(obj);
// States (9.5 + 9.6):
lv_obj_add_state(obj, LV_STATE_CHECKED);  lv_obj_remove_state(obj, LV_STATE_CHECKED);  lv_obj_has_state(obj, LV_STATE_CHECKED);
lv_obj_set_scrollbar_mode(obj, LV_SCROLLBAR_MODE_OFF);   // OFF, ON, ACTIVE, AUTO
lv_obj_set_scroll_dir(obj, LV_DIR_VER);
\`\`\`
`;

export const LAYOUTS = `# Layouts: size, position, flex and grid

## Size, position, alignment
\`\`\`c
lv_obj_set_size(obj, 120, 40);  lv_obj_set_width(obj, LV_PCT(50));  lv_obj_set_height(obj, LV_SIZE_CONTENT);
lv_obj_set_pos(obj, 10, 20);    lv_obj_center(obj);
lv_obj_align(obj, LV_ALIGN_TOP_MID, 0, 10);
lv_obj_align_to(obj, ref, LV_ALIGN_OUT_BOTTOM_MID, 0, 8);
// LV_ALIGN_{TOP,BOTTOM}_{LEFT,MID,RIGHT}, LV_ALIGN_{LEFT,RIGHT}_MID, LV_ALIGN_CENTER,
// LV_ALIGN_OUT_{TOP,BOTTOM}_{LEFT,MID,RIGHT}, LV_ALIGN_OUT_{LEFT,RIGHT}_{TOP,MID,BOTTOM}
\`\`\`

## Flex & grid layout
\`\`\`c
lv_obj_set_flex_flow(cont, LV_FLEX_FLOW_ROW);   // ROW, COLUMN, ROW_WRAP, COLUMN_WRAP, *_REVERSE
lv_obj_set_flex_align(cont, LV_FLEX_ALIGN_SPACE_BETWEEN,  // main: START END CENTER SPACE_BETWEEN SPACE_AROUND SPACE_EVENLY
                            LV_FLEX_ALIGN_CENTER,         // cross
                            LV_FLEX_ALIGN_CENTER);        // track
lv_obj_set_flex_grow(child, 1);
lv_obj_set_style_pad_row(cont, 8, 0);  lv_obj_set_style_pad_column(cont, 8, 0);  // or pad_gap

static int32_t col_dsc[] = {100, LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST};
static int32_t row_dsc[] = {40, 40, LV_GRID_TEMPLATE_LAST};
lv_obj_set_grid_dsc_array(cont, col_dsc, row_dsc);
lv_obj_set_grid_cell(child, LV_GRID_ALIGN_STRETCH, 0, 1, LV_GRID_ALIGN_CENTER, 1, 1);
\`\`\`
Children of a flex/grid container ignore lv_obj_set_pos/align unless they are floating
(LV_OBJ_FLAG_FLOATING / [9.6+] lv_obj_set_floating).
`;

export const STYLES = `# Styles

## Styles
\`\`\`c
lv_obj_set_style_bg_color(obj, lv_color_hex(0x003a57), 0);   // selector 0 = LV_PART_MAIN | LV_STATE_DEFAULT
lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
lv_obj_set_style_bg_grad_color(obj, lv_color_hex(0x0080ff), 0);
lv_obj_set_style_bg_grad_dir(obj, LV_GRAD_DIR_VER, 0);
lv_obj_set_style_text_color(obj, lv_color_white(), 0);
lv_obj_set_style_text_font(obj, &lv_font_montserrat_20, 0);
lv_obj_set_style_text_align(obj, LV_TEXT_ALIGN_CENTER, 0);
lv_obj_set_style_border_width(obj, 2, 0);  lv_obj_set_style_border_color(obj, lv_color_black(), 0);
lv_obj_set_style_radius(obj, 8, 0);        // LV_RADIUS_CIRCLE for pills/circles
lv_obj_set_style_pad_all(obj, 10, 0);      lv_obj_set_style_pad_hor(obj, 12, 0);
lv_obj_set_style_shadow_width(obj, 12, 0); lv_obj_set_style_shadow_offset_y(obj, 4, 0);
lv_obj_set_style_opa(obj, LV_OPA_50, 0);
lv_obj_set_style_bg_color(slider, lv_palette_main(LV_PALETTE_RED), LV_PART_INDICATOR);
lv_obj_set_style_bg_color(btn, lv_color_hex(0x444444), LV_PART_MAIN | LV_STATE_PRESSED);

static lv_style_t st;            // reusable style: must be static/global
lv_style_init(&st);
lv_style_set_bg_color(&st, lv_color_hex(0x202020));
lv_obj_add_style(obj, &st, 0);
lv_obj_remove_style_all(obj);    // start from a blank object
\`\`\`
Colors: lv_color_hex(0xRRGGBB), lv_color_make(r,g,b), lv_color_white(), lv_color_black(),
lv_palette_main/lighten/darken(LV_PALETTE_RED|PINK|PURPLE|DEEP_PURPLE|INDIGO|BLUE|LIGHT_BLUE|CYAN|TEAL|GREEN|LIGHT_GREEN|LIME|YELLOW|AMBER|ORANGE|DEEP_ORANGE|BROWN|BLUE_GREY|GREY, level).
Parts: LV_PART_MAIN, SCROLLBAR, INDICATOR, KNOB, SELECTED, ITEMS, CURSOR.
States: LV_STATE_DEFAULT, CHECKED, FOCUSED, FOCUS_KEY, EDITED, HOVERED, PRESSED, SCROLLED, DISABLED.
`;

export const EVENTS = `# Events

## Events
\`\`\`c
static void btn_cb(lv_event_t *e) {                // file scope -> lvgl_render_full
    lv_obj_t *target = lv_event_get_target_obj(e);
    lv_event_code_t code = lv_event_get_code(e);
    void *ud = lv_event_get_user_data(e);
}
lv_obj_add_event_cb(btn, btn_cb, LV_EVENT_CLICKED, NULL);   // CLICKED, PRESSED, VALUE_CHANGED, READY, ALL ...
lv_obj_send_event(btn, LV_EVENT_CLICKED, NULL);              // trigger manually
\`\`\`

In the simulator, real input goes through the \`actions\` render parameter (click/press/drag/key/type/focus via
real LVGL input devices, see lvgl_docs topic "actions"); the render result lists the CLICKED, VALUE_CHANGED,
PRESSED, RELEASED, FOCUSED and SCREEN_LOADED events that fired (\`events\`).
`;

export const ANIM = `# Timers & animations

## Timers & animations
\`\`\`c
static void tick_cb(lv_timer_t *t) { lv_obj_t *lbl = lv_timer_get_user_data(t); /* ... */ }
lv_timer_t *t = lv_timer_create(tick_cb, 100 /* ms */, label);   lv_timer_set_repeat_count(t, 5);

lv_anim_t a;
lv_anim_init(&a);
lv_anim_set_var(&a, obj);
lv_anim_set_values(&a, 0, 200);
lv_anim_set_duration(&a, 300);
lv_anim_set_exec_cb(&a, (lv_anim_exec_xcb_t)lv_obj_set_x);
lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
lv_anim_start(&a);
\`\`\`
Only ~330 ms pass before the screenshot (time_ms); use settle=true to capture the final state, or\n\`frames\` (e.g. [0, 150, 300, 600]) to get one image per point in time and see the motion.
`;

export const V8_MIGRATION = `# 9.6 deprecations and v8 -> v9 migration

## Deprecated in 9.6 (removed in v10)
The old names still work in 9.5 and 9.6 (9.6 prints a -Wdeprecated-declarations warning), so **prefer the
old names for code that must also build on 9.5 devices**; use the replacements for 9.6-only projects.
| Deprecated | Replacement [9.6+] |
|---|---|
| lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN) / lv_obj_remove_flag(...) | lv_obj_set_hidden(o, true/false) |
| lv_obj_add/remove_flag(o, LV_OBJ_FLAG_CLICKABLE / SCROLLABLE / CHECKABLE / ...) | lv_obj_set_clickable / lv_obj_set_scrollable / lv_obj_set_checkable / lv_obj_set_<flag>(o, en) |
| lv_obj_set_flag(o, f, v) | lv_obj_set_<flag>(o, v) |
| lv_obj_has_flag(o, LV_OBJ_FLAG_HIDDEN) / lv_obj_has_flag_any | lv_obj_is_hidden(o), lv_obj_is_<flag>(o) |
| lv_obj_add_state(o, LV_STATE_CHECKED) (not deprecated) | also lv_obj_set_checked(o, true) [9.6+] |
| lv_list_create, lv_list_add_button, lv_list_add_text | flex column container (LV_FLEX_FLOW_COLUMN) with full-width buttons/labels |
| lv_menu_create and lv_menu_* | build navigation from base widgets (containers + buttons, screen/tab switching) |
| lv_win_create and lv_win_* | flex column: header container + content container |
| lv_textarea_set_align | text_align style (lv_obj_set_style_text_align) |
| lv_obj_set_id / IDs for lookup | lv_obj_set_name + lv_obj_find_by_name |

## v8 -> v9 renames (use the v9 names; many v8 names are only compatibility macros)
| v8 | v9 |
|---|---|
| lv_scr_act(), lv_scr_load() | lv_screen_active(), lv_screen_load() |
| lv_btn_create, lv_btn_* | lv_button_create, lv_button_* |
| lv_btnmatrix_* | lv_buttonmatrix_* |
| lv_img_create, lv_img_set_src, lv_img_set_zoom, lv_img_set_angle | lv_image_create, lv_image_set_src, lv_image_set_scale, lv_image_set_rotation |
| lv_img_dsc_t, LV_IMG_DECLARE | lv_image_dsc_t, LV_IMAGE_DECLARE |
| lv_imgbtn_* | lv_imagebutton_* |
| lv_obj_clear_flag, lv_obj_clear_state | lv_obj_remove_flag, lv_obj_remove_state |
| lv_obj_del, lv_obj_del_async, lv_obj_get_child_cnt | lv_obj_delete, lv_obj_delete_async, lv_obj_get_child_count |
| lv_disp_*, lv_disp_get_default | lv_display_*, lv_display_get_default |
| lv_indev_get_act | lv_indev_active |
| lv_coord_t | int32_t |
| LV_LABEL_LONG_WRAP / DOT / SCROLL / SCROLL_CIRCULAR / CLIP | LV_LABEL_LONG_MODE_WRAP / DOTS / SCROLL / SCROLL_CIRCULAR / CLIP |
| lv_chart_set_range(ch, axis, min, max) | lv_chart_set_axis_range(ch, axis, min, max) |
| lv_table_set_col_cnt / set_row_cnt / set_col_width | lv_table_set_column_count / set_row_count / set_column_width |
| lv_led_set_bright | lv_led_set_brightness |
| lv_anim_set_time, lv_anim_set_playback_time | lv_anim_set_duration, lv_anim_set_reverse_duration |
| lv_timer_del | lv_timer_delete |
| lv_obj_set_style_img_*, lv_style_set_img_* | lv_obj_set_style_image_*, lv_style_set_image_* |
| lv_obj_set_style_shadow_ofs_x/y | lv_obj_set_style_shadow_offset_x/y |
| lv_obj_set_style_anim_time | lv_obj_set_style_anim_duration |
| LV_ZOOM_NONE | LV_SCALE_NONE |
| lv_event_get_target (lv_obj_t*) | lv_event_get_target_obj (lv_event_get_target returns void*) |
| lv_msgbox_create(parent, title, txt, btns, close) | lv_msgbox_create(parent) + lv_msgbox_add_title/add_text/add_footer_button/add_close_button |
| lv_tabview_create(parent, dir, size) | lv_tabview_create(parent) + lv_tabview_set_tab_bar_position/set_tab_bar_size |
| lv_spinner_create(parent, time, arc_len) | lv_spinner_create(parent) + lv_spinner_set_anim_params |
| lv_meter_* | lv_scale (+ lv_arc / lv_line needles) |
| lv_colorwheel_* | removed (build from lv_arc / lv_scale) |
`;

export const SYMBOLS = `# Symbols

## Symbols (built into the Montserrat fonts)
LV_SYMBOL_AUDIO VIDEO LIST OK CLOSE POWER SETTINGS HOME DOWNLOAD DRIVE REFRESH MUTE VOLUME_MID VOLUME_MAX
IMAGE TINT PREV PLAY PAUSE STOP NEXT EJECT LEFT RIGHT PLUS MINUS EYE_OPEN EYE_CLOSE WARNING SHUFFLE UP DOWN
LOOP DIRECTORY UPLOAD CALL CUT COPY SAVE BARS ENVELOPE CHARGE PASTE BELL KEYBOARD GPS FILE WIFI
BATTERY_FULL BATTERY_3 BATTERY_2 BATTERY_1 BATTERY_EMPTY USB BLUETOOTH TRASH EDIT BACKSPACE SD_CARD NEW_LINE
(use as strings: \`lv_label_set_text(l, LV_SYMBOL_WIFI " Connected");\`)
`;
