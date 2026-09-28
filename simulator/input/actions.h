/**
 * @file actions.h
 * Action scripts (contract section 2): a JSON array of single-key objects
 * that drive the virtual pointer/keypad, advance time and take captures.
 */
#ifndef SIM_ACTIONS_H
#define SIM_ACTIONS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct sim_actions sim_actions_t;

/**
 * Load and validate a script. On error returns NULL and writes a message
 * ("actions[2].click: ...") into err.
 */
sim_actions_t *actions_load(const char *path, char *err, size_t errsz);

/** Script equivalent of --frames: wait + capture "t<ms>" per time */
sim_actions_t *actions_from_frames(const int32_t *frames, uint32_t count);

/** True when the script uses key/type/focus (needs the keypad + group) */
bool actions_need_keypad(const sim_actions_t *a);

/**
 * Run the script. Returns 0, SIM_EXIT_ACTIONS (message already printed,
 * e.g. an unknown object name) or SIM_EXIT_WRITE (a capture failed).
 */
int actions_run(sim_actions_t *a);

void actions_free(sim_actions_t *a);

#endif /* SIM_ACTIONS_H */
