#include "libs/eadk.h"
#include "libs/storage.h"
#include "periodic.h"

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

#define SOURCE_CACHE_WIDTH 1280
static eadk_color_t source_cache[SOURCE_CACHE_WIDTH];
static int cached_source_y = -1;

static int source_y_lookup[240];
static int source_y_lookup_valid = 0;

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

static void decode_source_line(const char* data, size_t data_size,
                               size_t offset[4], int source_y) {
    for (int c = 0; c < 4; ++c) {
        size_t i = offset[c];
        uint32_t pixels_drawn = 0;
        int cache_x = c * 320;
        
        while (pixels_drawn < 320 && i < data_size) {
            uint8_t b = (uint8_t)data[i++];
            uint32_t run = ((b >> 4) & 0x0F) + 1;
            uint8_t index = b & 0x0F;
            uint16_t color = grayscale_palette[index];
            
            for (uint32_t rr = 0; rr < run && pixels_drawn < 320; ++rr) {
                source_cache[cache_x + pixels_drawn] = color;
                pixels_drawn++;
            }
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
        
        if (src_x >= 0 && src_x < SOURCE_CACHE_WIDTH) {
            row_ptr[screen_x] = source_cache[src_x];
        }
    }
}

int main(void) {
    periodic();

    eadk_display_push_rect_uniform(eadk_screen_rect, eadk_color_white);
    
    const char* data = eadk_external_data;
    size_t data_size = eadk_external_data_size;

    size_t off = 0;
    size_t line_count = 0;
    while (off < data_size) {
        size_t lb = line_bytes(data, data_size, off);
        if (lb == 0) break;
        line_count++;
        off += lb;
    }

    if (line_count == 0) {
        while (1) {
            if (eadk_keyboard_key_down(eadk_keyboard_scan(), eadk_key_home)) break;
        }
        return 0;
    }

    size_t* offsets = (size_t*)malloc(line_count * sizeof(size_t));
    if (!offsets) return 0;

    off = 0;
    size_t li = 0;
    while (off < data_size && li < line_count) {
        offsets[li++] = off;
        size_t lb = line_bytes(data, data_size, off);
        off += lb;
    }

    const size_t cols = 4;
    size_t rows = line_count / cols;
    int total_w = (int)cols * 320;
    int total_h = (int)rows;

    int view_x = 0, view_y = 0;
    const int step = 32;

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
            size_t col_offsets[4];
            for (int c = 0; c < 4; ++c) {
                size_t idx = (size_t)source_y * cols + (size_t)c;
                col_offsets[c] = (idx < line_count) ? offsets[idx] : 0;
            }
            decode_source_line(data, data_size, col_offsets, source_y);
        }
        
        render_from_cache(screen_y, view_x, scale);
    }
    flush_line_buffer();

    int pan_step = 16;
    uint64_t last_ms = eadk_timing_millis();

    while (1) {
        uint64_t now = eadk_timing_millis();
        last_ms = now;

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
                    size_t col_offsets[4];
                    for (int c = 0; c < 4; ++c) {
                        size_t idx = (size_t)source_y * cols + (size_t)c;
                        col_offsets[c] = (idx < line_count) ? offsets[idx] : 0;
                    }
                    decode_source_line(data, data_size, col_offsets, source_y);
                }
                
                render_from_cache(screen_y, view_x, scale);
            }
            flush_line_buffer();
        }
    }

    free(offsets);

    return 0;
}

