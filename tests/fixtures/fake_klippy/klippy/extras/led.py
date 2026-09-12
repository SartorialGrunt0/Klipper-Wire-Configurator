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


class TemplateLED:
    def __init__(self, gcode, led):
        gcode.register_command('FAKE_ONE_SHOT', self.cmd_one_shot,
                               desc=self.cmd_one_shot_help)

    def shutdown(self):
        # Unregistration call: func=None must NOT create a command entry.
        self.gcode.register_command('FAKE_ONE_SHOT', None)
