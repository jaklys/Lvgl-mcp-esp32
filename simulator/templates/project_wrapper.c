/*
 * Entry wrapper for multi-file projects (lvgl_render_project): the simulator
 * calls create_ui(), which calls the project's entry function.
 * %ENTRY% is replaced by the entry name (default "ui_init"; "app_main" works
 * too: an endless task loop is detected and left after 5 s of simulated time).
 */
#include "lvgl.h"
#include "sim.h"

#ifdef __cplusplus
extern "C" {
#endif
void %ENTRY%(void);
#ifdef __cplusplus
}
#endif

void create_ui(void)
{
    %ENTRY%();
}
