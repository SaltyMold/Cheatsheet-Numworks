#include "libs/eadk.h"
#include "libs/storage.h"
#include "periodic.h"
#include <stdlib.h>
#include <stdint.h>
#include <limits.h>
#include <math.h>

const char eadk_app_name[] __attribute__((section(".rodata.eadk_app_name"))) = "Periodic";
const uint32_t eadk_api_level  __attribute__((section(".rodata.eadk_api_level"))) = 0;

static const uint16_t grayscale_palette[16] = {
    0x0000, 0x1082, 0x2104, 0x3186,
    0x4228, 0x52AA, 0x632C, 0x73AE,
    0x8C51, 0x9CD3, 0xAD55, 0xBDD7,
    0xCE79, 0xDE7B, 0xEF7D, 0xFFFF
};

#define BUFFER_HEIGHT 120
#define BUFFER_WIDTH 320
static eadk_color_t line_buffer[BUFFER_HEIGHT * BUFFER_WIDTH];
static int buffer_y_start = 0;
static int buffer_line_count = 0;

#define SOURCE_CACHE_WIDTH 3840
static eadk_color_t source_cache[SOURCE_CACHE_WIDTH];
static int cached_source_y = -1;
static int source_cache_used_width = 0;

static int source_y_lookup[240];
static int source_y_lookup_valid = 0;
/* scan hint to allow incremental scanning across successive rows */
static size_t scan_hint_idx = 0;
static size_t scan_hint_off = 0;
static int scan_hint_valid = 0;
/* small cache of recently computed row offsets */
#define ROW_CACHE_SIZE 8
#define MAX_COLS 12
static size_t row_cache_keys[ROW_CACHE_SIZE];
static size_t row_cache_offsets[ROW_CACHE_SIZE][MAX_COLS];
static size_t row_cache_next = 0;

static void row_cache_init(void) {
    for (size_t i = 0; i < ROW_CACHE_SIZE; ++i) row_cache_keys[i] = SIZE_MAX;
    row_cache_next = 0;
}

static int row_cache_get(size_t source_y, size_t *out_offsets, size_t cols) {
    for (size_t i = 0; i < ROW_CACHE_SIZE; ++i) {
        if (row_cache_keys[i] == source_y) {
            for (size_t c = 0; c < cols; ++c) out_offsets[c] = row_cache_offsets[i][c];
            return 1;
        }
    }
    return 0;
}

static void row_cache_put(size_t source_y, const size_t *offsets, size_t cols) {
    size_t idx = row_cache_next % ROW_CACHE_SIZE;
    row_cache_keys[idx] = source_y;
    for (size_t c = 0; c < cols; ++c) row_cache_offsets[idx][c] = offsets[c];
    row_cache_next = (row_cache_next + 1) % ROW_CACHE_SIZE;
}

static void flush_line_buffer(void) {
    if (buffer_line_count == 0) return;
    eadk_display_push_rect(
        (eadk_rect_t){0, (uint16_t)buffer_y_start, BUFFER_WIDTH, (uint16_t)buffer_line_count},
        line_buffer
    );
    buffer_line_count = 0;
}

static void build_source_y_lookup(int view_y, double scale, int rows) {
    for (int screen_y = 0; screen_y < 240; ++screen_y) {
        source_y_lookup[screen_y] = (int)floor(view_y + screen_y * scale);
    }
    source_y_lookup_valid = 1;
}


static size_t line_bytes(const char* d, size_t sz, size_t off) {
    if (off >= sz) return 0;
    size_t i = off;
    uint32_t pixels = 0;
    while (pixels < 320 && i < sz) {
        uint8_t b = (uint8_t)d[i++];
        uint32_t run = ((b >> 4) & 0x0F) + 1;
        pixels += run;
    }
    return (pixels >= 320) ? (i - off) : 0;
}

static size_t get_offset_for_index(const char *data_local, size_t data_sz, size_t target_idx,
                                   size_t line_cnt, size_t sample_interval,
                                   const size_t *samples_local, size_t samples_cnt) {
    if (target_idx >= line_cnt) return SIZE_MAX;
    size_t sample_i = target_idx / sample_interval;
    if (sample_i >= samples_cnt) sample_i = samples_cnt ? samples_cnt - 1 : 0;
    size_t offi = samples_local[sample_i];
    size_t cur = sample_i * sample_interval;
    while (cur < target_idx && offi < data_sz) {
        size_t lb = line_bytes(data_local, data_sz, offi);
        if (lb == 0) return SIZE_MAX;
        offi += lb;
        cur++;
    }
    return offi;
}

static int populate_col_offsets(const char *data_local, size_t data_sz,
                                size_t *col_offsets, size_t cols, size_t source_y,
                                size_t line_cnt, size_t sample_interval,
                                const size_t *samples_local, size_t samples_cnt) {
    size_t idx_start = (size_t)source_y * cols;
    if (idx_start >= line_cnt) {
        for (size_t c = 0; c < cols; ++c) col_offsets[c] = SIZE_MAX;
        return 0;
    }

    size_t sample_i = idx_start / sample_interval;
    if (sample_i >= samples_cnt) sample_i = samples_cnt ? samples_cnt - 1 : 0;
    size_t off = samples_local[sample_i];
    size_t cur = sample_i * sample_interval;

    /* If we have a recent scan hint and it's closer, start from it */
    if (scan_hint_valid && scan_hint_idx <= idx_start && scan_hint_idx >= sample_i * sample_interval) {
        off = scan_hint_off;
        cur = scan_hint_idx;
    }

    /* advance to idx_start */
    while (cur < idx_start && off < data_sz) {
        size_t lb = line_bytes(data_local, data_sz, off);
        if (lb == 0) return -1;
        off += lb;
        cur++;
    }

    /* fill offsets for this row sequentially */
    for (size_t c = 0; c < cols; ++c) {
        size_t idx = idx_start + c;
        if (idx >= line_cnt) { col_offsets[c] = SIZE_MAX; continue; }
        if (off >= data_sz) { col_offsets[c] = SIZE_MAX; continue; }
        col_offsets[c] = off;
        size_t lb = line_bytes(data_local, data_sz, off);
        if (lb == 0) { /* mark remaining as missing */
            for (size_t cc = c + 1; cc < cols; ++cc) col_offsets[cc] = SIZE_MAX;
            return -1;
        }
        off += lb;
    }
    /* update scan hint to the position after the last filled line */
    scan_hint_idx = idx_start + cols;
    scan_hint_off = off;
    return 0;
}

static void decode_source_line(const char* data, size_t data_size,
                               const size_t *offsets, int source_y, size_t cols) {
    for (size_t c = 0; c < cols; ++c) {
        int cache_x = (int)(c * 320);
        uint32_t pixels_drawn = 0;
        size_t i = offsets[c];

        if (i == SIZE_MAX) {
            for (int x = 0; x < 320; ++x) {
                int idx = cache_x + x;
                if (idx >= 0 && idx < source_cache_used_width) source_cache[idx] = eadk_color_white;
            }
            continue;
        }

        while (pixels_drawn < 320 && i < data_size) {
            uint8_t b = (uint8_t)data[i++];
            uint32_t run = ((b >> 4) & 0x0F) + 1;
            uint8_t index = b & 0x0F;
            uint16_t color = grayscale_palette[index];

            for (uint32_t rr = 0; rr < run && pixels_drawn < 320; ++rr) {
                int idx = cache_x + (int)pixels_drawn;
                if (idx >= 0 && idx < source_cache_used_width) {
                    source_cache[idx] = color;
                }
                pixels_drawn++;
            }
        }
        /* If stream ended before filling 320 pixels, pad with white */
        while (pixels_drawn < 320) {
            int idx = cache_x + (int)pixels_drawn;
            if (idx >= 0 && idx < source_cache_used_width) source_cache[idx] = eadk_color_white;
            pixels_drawn++;
        }
    }
    cached_source_y = source_y;
}

static void render_from_cache(int screen_y, int view_x, double scale) {
    if (screen_y < 0 || screen_y >= 240) return;
    
    if (buffer_line_count == 0) {
        buffer_y_start = screen_y;
    }
    
    if (screen_y < buffer_y_start || screen_y >= buffer_y_start + BUFFER_HEIGHT) {
        flush_line_buffer();
        buffer_y_start = screen_y;
    }
    
    int buffer_row = screen_y - buffer_y_start;
    eadk_color_t* row_ptr = &line_buffer[buffer_row * BUFFER_WIDTH];
    eadk_color_t bg = eadk_color_white;
    
    if (buffer_line_count <= buffer_row) {
        for (int i = 0; i < BUFFER_WIDTH; ++i) {
            row_ptr[i] = bg;
        }
        if (buffer_line_count == buffer_row) {
            buffer_line_count = buffer_row + 1;
        }
    }
    
    for (int screen_x = 0; screen_x < 320; ++screen_x) {
        double delta_x = (double)screen_x * scale + view_x;
        int src_x = (int)floor(delta_x);
        
        if (src_x >= 0 && src_x < source_cache_used_width) {
            row_ptr[screen_x] = source_cache[src_x];
        }
    }
}

int main(void) {
    //periodic();

    eadk_display_push_rect_uniform(eadk_screen_rect, eadk_color_white);
    
    const char* data = eadk_external_data;
    size_t data_size = eadk_external_data_size;

    size_t total_pixels = 0;
    for (size_t i = 0; i < data_size; ++i) {
        uint8_t b = (uint8_t)data[i];
        total_pixels += ((b >> 4) & 0x0F) + 1;
    }

    if (total_pixels == 0) {
        while (1) {
            if (eadk_keyboard_key_down(eadk_keyboard_scan(), eadk_key_home)) break;
        }
        return 0;
    }

    size_t expected_line_count = total_pixels / 320ULL;

    /* To save RAM we don't store an offset per line. Instead store
       sparse samples every SAMPLE_INTERVAL lines and scan on-demand. */
    const size_t SAMPLE_INTERVAL = 64;
    size_t sample_slots = (expected_line_count + SAMPLE_INTERVAL - 1) / SAMPLE_INTERVAL;
    size_t *samples = (size_t*)malloc(sample_slots * sizeof(size_t));
    if (!samples) return 0;
    size_t off = 0;
    size_t li = 0;
    size_t sample_idx = 0;
    while (off < data_size) {
        size_t lb = line_bytes(data, data_size, off);
        if (lb == 0) break;
        if ((li % SAMPLE_INTERVAL) == 0 && sample_idx < sample_slots) samples[sample_idx++] = off;
        li++;
        off += lb;
    }

    /* scan hint will be initialized after samples_count is known */

    if (li == 0) {
        free(samples);
        while (1) { if (eadk_keyboard_key_down(eadk_keyboard_scan(), eadk_key_home)) break; }
        return 0;
    }

    size_t line_count = (li < expected_line_count) ? li : expected_line_count;

    size_t samples_count = sample_idx;

    /* initialize scan hint and row cache now that samples_count is known */
    if (samples_count > 0) {
        scan_hint_idx = 0;
        scan_hint_off = samples[0];
        scan_hint_valid = 1;
    } else {
        scan_hint_idx = 0;
        scan_hint_off = 0;
        scan_hint_valid = 0;
    }
    row_cache_init();

    size_t cols = 0;
    double sqv = (double)line_count / 240.0;
    if (sqv > 0.0) {
        size_t sc = (size_t)(sqrt(sqv) + 0.5);
        if (sc >= 1 && sc <= 12 && (size_t)sc * (size_t)sc * 240ULL == line_count) {
            cols = sc;
        }
    }

    if (cols == 0) {
        size_t best_cols2 = 0;
        double best_score = -1.0;
        for (size_t c = 1; c <= 12; ++c) {
            if (line_count % c != 0) continue;
            size_t r = line_count / c;
            if (r < 240) continue;
            if (r % 240 != 0) continue;
            int w = (int)(c * 320);
            if (w > SOURCE_CACHE_WIDTH) continue;

            int nsamples = 0;
            uint64_t sum = 0;
            uint64_t sumsq = 0;
            int max_samples = (r > 8) ? 8 : (int)(r - 1);
            for (int k = 0; k < max_samples; ++k) {
                size_t a = (size_t)k * c;
                size_t b = (size_t)(k + 1) * c;
                if (b >= line_count || a >= line_count) break;
                if (b >= li || a >= li) break; 
                size_t off_a = get_offset_for_index(data, data_size, a, line_count, SAMPLE_INTERVAL, samples, samples_count);
                size_t off_b = get_offset_for_index(data, data_size, b, line_count, SAMPLE_INTERVAL, samples, samples_count);
                if (off_a == SIZE_MAX || off_b == SIZE_MAX) { nsamples = 0; break; }
                uint64_t bytes = (uint64_t)off_b - (uint64_t)off_a;
                if (bytes == 0) { nsamples = 0; break; }
                sum += bytes;
                sumsq += bytes * bytes;
                nsamples++;
            }
            if (nsamples < 2) continue;
            double mean = (double)sum / (double)nsamples;
            double var = (double)sumsq / (double)nsamples - mean * mean;
            if (var < 0) var = 0;
            double rel_var = var / (mean * mean + 1e-9);
            double score = (1.0 / (1.0 + rel_var)) * mean;
            if (best_score < 0 || score > best_score) {
                best_score = score;
                best_cols2 = c;
            }
        }
        cols = best_cols2 ? best_cols2 : 4;
    }
    size_t rows = line_count / cols;
    int total_w = (int)cols * 320;
    int total_h = (int)rows;
    source_cache_used_width = total_w;    

    int view_x = 0, view_y = 0;

    double max_scale = (double)total_w / 320.0;
    double max_scale_y = (double)total_h / 240.0;
    if (max_scale_y < max_scale) max_scale = max_scale_y;
    if (max_scale < 1.0) max_scale = 1.0; 
    
    double scale = 4.0;

    buffer_line_count = 0;
    cached_source_y = -1;
    build_source_y_lookup(view_y, scale, rows);
    eadk_display_push_rect_uniform(eadk_screen_rect, eadk_color_white);
    for (int screen_y = 0; screen_y < 240; ++screen_y) {
        int source_y = source_y_lookup[screen_y];
        if (source_y < 0 || source_y >= (int)rows) continue;
        
        if (source_y != cached_source_y) {
            size_t col_offsets_local[MAX_COLS];
            size_t *col_offsets = NULL;
            int col_offsets_heap = 0;
            if (cols <= MAX_COLS) {
                col_offsets = col_offsets_local;
            } else {
                col_offsets = (size_t*)malloc(cols * sizeof(size_t));
                if (!col_offsets) break;
                col_offsets_heap = 1;
            }
            if (!row_cache_get((size_t)source_y, col_offsets, cols)) {
                if (populate_col_offsets(data, data_size, col_offsets, cols, (size_t)source_y, line_count, SAMPLE_INTERVAL, samples, samples_count) < 0) {
                    /* fallback: fill with per-index lookups */
                    for (size_t c = 0; c < cols; ++c) {
                        size_t idx = (size_t)source_y * cols + c;
                        col_offsets[c] = (idx < line_count) ? get_offset_for_index(data, data_size, idx, line_count, SAMPLE_INTERVAL, samples, samples_count) : SIZE_MAX;
                    }
                }
                row_cache_put((size_t)source_y, col_offsets, cols);
            }
            decode_source_line(data, data_size, col_offsets, source_y, cols);
            if (col_offsets_heap) free(col_offsets);
        }
        
        render_from_cache(screen_y, view_x, scale);
    }
    flush_line_buffer();

    int pan_step = 16;

    while (1) {

        /*
        {
            char buf[80];
            int y = 2;
            eadk_point_t p;
            p.x = 2;
            p.y = (uint16_t)y;
            snprintf(buf, sizeof(buf), "total_pixels=%zu", total_pixels);
            eadk_display_draw_string(buf, p, false, eadk_color_black, eadk_color_white);
            y += 12; p.y = (uint16_t)y;
            snprintf(buf, sizeof(buf), "expected_lines=%zu found_offsets=%zu", expected_line_count, li);
            eadk_display_draw_string(buf, p, false, eadk_color_black, eadk_color_white);
            y += 12; p.y = (uint16_t)y;
            snprintf(buf, sizeof(buf), "line_count=%zu cols=%zu rows=%zu", line_count, cols, rows);
            eadk_display_draw_string(buf, p, false, eadk_color_black, eadk_color_white);
            y += 12; p.y = (uint16_t)y;
            snprintf(buf, sizeof(buf), "total_w=%d total_h=%d", total_w, total_h);
            eadk_display_draw_string(buf, p, false, eadk_color_black, eadk_color_white);
        }
        */

        uint64_t now = eadk_timing_millis();

        eadk_keyboard_state_t st = eadk_keyboard_scan();
        if (eadk_keyboard_key_down(st, eadk_key_home)) break;

        int moved = 0;
        if (eadk_keyboard_key_down(st, eadk_key_right)) { view_x += pan_step * scale; moved = 1; }
        if (eadk_keyboard_key_down(st, eadk_key_left))  { view_x -= pan_step * scale; moved = 1; }
        if (eadk_keyboard_key_down(st, eadk_key_down))  { view_y += pan_step * scale; moved = 1; }
        if (eadk_keyboard_key_down(st, eadk_key_up))    { view_y -= pan_step * scale; moved = 1; }

        int zoomed = 0;
        if (eadk_keyboard_key_down(st, eadk_key_back)) {
            if (scale < max_scale) {
                double old_scale = scale;
                double center_x = (double)view_x + (320.0 * old_scale) / 2.0;
                double center_y = (double)view_y + (240.0 * old_scale) / 2.0;
                double new_scale = old_scale + 0.25;
                if (new_scale > max_scale) new_scale = max_scale;
                scale = new_scale;
                view_x = (int)floor(center_x - (320.0 * scale) / 2.0);
                view_y = (int)floor(center_y - (240.0 * scale) / 2.0);
                zoomed = 1;
            }
        }
        if (eadk_keyboard_key_down(st, eadk_key_ok)) {
            if (scale > 1.0) {
                double old_scale = scale;
                double center_x = (double)view_x + (320.0 * old_scale) / 2.0;
                double center_y = (double)view_y + (240.0 * old_scale) / 2.0;
                double new_scale = old_scale - 0.25;
                if (new_scale < 1.0) new_scale = 1.0;
                scale = new_scale;
                view_x = (int)floor(center_x - (320.0 * scale) / 2.0);
                view_y = (int)floor(center_y - (240.0 * scale) / 2.0);
                zoomed = 1;
            }
        }

        int max_view_x = total_w - (int)ceil(320.0 * scale);
        int max_view_y = total_h - (int)ceil(240.0 * scale);
        if (max_view_x < 0) max_view_x = 0;
        if (max_view_y < 0) max_view_y = 0;
        if (view_x < 0) view_x = 0;
        if (view_y < 0) view_y = 0;
        if (view_x > max_view_x) view_x = max_view_x;
        if (view_y > max_view_y) view_y = max_view_y;

        if (moved || zoomed) {
            buffer_line_count = 0;
            cached_source_y = -1;
            build_source_y_lookup(view_y, scale, rows);
            for (int screen_y = 0; screen_y < 240; ++screen_y) {
                int source_y = source_y_lookup[screen_y];
                if (source_y < 0 || source_y >= (int)rows) continue;
                
                if (source_y != cached_source_y) {
                                    size_t col_offsets_local[MAX_COLS];
                                    size_t *col_offsets = NULL;
                                    int col_offsets_heap = 0;
                                    if (cols <= MAX_COLS) {
                                        col_offsets = col_offsets_local;
                                    } else {
                                        col_offsets = (size_t*)malloc(cols * sizeof(size_t));
                                        if (!col_offsets) break;
                                        col_offsets_heap = 1;
                                    }
                                    if (!row_cache_get((size_t)source_y, col_offsets, cols)) {
                                        if (populate_col_offsets(data, data_size, col_offsets, cols, (size_t)source_y, line_count, SAMPLE_INTERVAL, samples, samples_count) < 0) {
                                            for (size_t c = 0; c < cols; ++c) {
                                                size_t idx = (size_t)source_y * cols + c;
                                                col_offsets[c] = (idx < line_count) ? get_offset_for_index(data, data_size, idx, line_count, SAMPLE_INTERVAL, samples, samples_count) : SIZE_MAX;
                                            }
                                        }
                                        row_cache_put((size_t)source_y, col_offsets, cols);
                                    }
                                    decode_source_line(data, data_size, col_offsets, source_y, cols);
                                    if (col_offsets_heap) free(col_offsets);
                }
                
                render_from_cache(screen_y, view_x, scale);
            }
            flush_line_buffer();
        }
    }

    free(samples);

    return 0;
}

