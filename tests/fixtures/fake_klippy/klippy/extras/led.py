"""Fake extras/led.py mirroring the real mux-registration shape."""

LED_COUNT = 0


class PrinterLED:
    def __init__(self, config, led):
        gcode = self.printer.lookup_object('gcode')
        name = config.get_name().split()[-1]
        gcode.register_mux_command("SET_LED", "LED", name, self.cmd_SET_LED,
                                   desc=self.cmd_SET_LED_help)
        gcode.register_mux_command("SET_LED_TEMPLATE", "LED", name,
                                   self.cmd_SET_LED_TEMPLATE)

    # Mirrors real led.py cmd_SET_LED param-parsing shape (get_float with
    # literal default, get_int with None default, getboolean, bare get =
    # required). The generator's type/default capture reads these.
    def cmd_SET_LED(self, gcmd):
        red = gcmd.get_float('RED', 0.)
        green = gcmd.get_float('GREEN', 0.)
        index = gcmd.get_int('INDEX', None, minval=1)
        sync = gcmd.getboolean('SYNC', True)
        label = gcmd.get('LABEL')
        _ = (red, green, index, sync, label)


class TemplateLED:
    def __init__(self, gcode, led):
        gcode.register_command('FAKE_ONE_SHOT', self.cmd_one_shot,
                               desc=self.cmd_one_shot_help)

    def shutdown(self):
        # Unregistration call: func=None must NOT create a command entry.
        self.gcode.register_command('FAKE_ONE_SHOT', None)
