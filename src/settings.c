#include "settings.h"
#include "libs/eadk.h"

#include "assets/calculator.h"

typedef struct {
    eadk_key_t key;
    uint8_t x;
    uint8_t y;
} KeyCoordinate;

/*
eadk_key_left = 0,
  eadk_key_up = 1,
  eadk_key_down = 2,
  eadk_key_right = 3,
  eadk_key_ok = 4,
  eadk_key_back = 5,
  eadk_key_home = 6,
  eadk_key_on_off = 8,
  eadk_key_shift = 12,
  eadk_key_alpha = 13,
  eadk_key_xnt = 14,
  eadk_key_var = 15,
  eadk_key_toolbox = 16,
  eadk_key_backspace = 17,
  eadk_key_exp = 18,
  eadk_key_ln = 19,
  eadk_key_log = 19,
  eadk_key_imaginary = 21,
  eadk_key_comma = 22,
  eadk_key_power = 23,
  eadk_key_sine = 24,
  eadk_key_cosine = 25,
  eadk_key_tangent = 26,
  eadk_key_pi = 27,
  eadk_key_sqrt = 28,
  eadk_key_square = 29,
  eadk_key_seven = 30,
  eadk_key_eight = 31,
  eadk_key_nine = 32,
  eadk_key_left_parenthesis = 33,
  eadk_key_right_parenthesis = 34,
  eadk_key_four = 36,
  eadk_key_five = 37,
  eadk_key_six = 38,
  eadk_key_multiplication = 39,
  eadk_key_division = 40,
  eadk_key_one = 42,
  eadk_key_two = 43,
  eadk_key_three = 44,
  eadk_key_plus = 45,
  eadk_key_minus = 46,
  eadk_key_zero = 48,
  eadk_key_dot = 49,
  eadk_key_ee = 50,
  eadk_key_ans = 51,
  eadk_key_exe = 52
*/
static const KeyCoordinate key_mappings[] = {
    {eadk_key_left  , 16, 112},
    {eadk_key_up    , 27, 102},
    {eadk_key_down  , 27, 122},
    {eadk_key_right , 37, 112},
    {eadk_key_ok    , 89, 112},
    {eadk_key_back  , 107, 112},
    {eadk_key_home  , 63, 104},
    {eadk_key_on_off, 63, 120},

    {eadk_key_shift    , 18, 138},
    {eadk_key_alpha    , 36, 138},
    {eadk_key_xnt      , 54, 138},
    {eadk_key_var      , 72, 138},
    {eadk_key_toolbox  , 89, 138},
    {eadk_key_backspace, 107, 138},

    {eadk_key_exp      , 18, 152},
    {eadk_key_ln       , 36, 152},
    {eadk_key_log      , 54, 152},
    {eadk_key_imaginary, 72, 152},
    {eadk_key_comma    , 89, 152},
    {eadk_key_power    , 107, 152},

    {eadk_key_sine   , 18, 166},
    {eadk_key_cosine , 36, 166},
    {eadk_key_tangent, 54, 166},
    {eadk_key_pi     , 72, 166},
    {eadk_key_sqrt   , 89, 166},
    {eadk_key_square , 107, 166},

    {eadk_key_seven            , 19, 181},
    {eadk_key_eight            , 41, 181},
    {eadk_key_nine             , 63, 181},
    {eadk_key_left_parenthesis , 84, 181},
    {eadk_key_right_parenthesis, 106, 181},

    {eadk_key_four          , 19, 196},
    {eadk_key_five          , 41, 196},
    {eadk_key_six           , 63, 196},
    {eadk_key_multiplication, 84, 196},
    {eadk_key_division      , 106, 196},

    {eadk_key_one  , 19, 212},
    {eadk_key_two  , 41, 212},
    {eadk_key_three, 63, 212},
    {eadk_key_plus , 84, 212},
    {eadk_key_minus, 106, 212},

    {eadk_key_zero, 19, 227},
    {eadk_key_dot , 41, 227},
    {eadk_key_ee  , 63, 227},
    {eadk_key_ans , 84, 227},
    {eadk_key_exe , 106, 227}
    
};

void settings() {
    eadk_display_push_rect_uniform(eadk_screen_rect, eadk_color_white);
    eadk_display_push_rect((eadk_rect_t){0, 0, calculator_width, calculator_height}, calculator_data);

    for (size_t i = 0; i < sizeof(key_mappings) / sizeof(KeyCoordinate); ++i) {
        eadk_display_push_rect_uniform((eadk_rect_t){key_mappings[i].x - 4, key_mappings[i].y - 4, 8, 8}, eadk_color_red);
    }
    eadk_timing_msleep(20000);
    
}