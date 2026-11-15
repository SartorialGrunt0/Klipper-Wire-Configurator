"""Fixture: a handler that hands its gcmd to a same-file callable.

Four shapes, each with a different resolution rule:
  * DELEGATE_METHOD   — obj.method(gcmd); the method name is unique.
  * DELEGATE_CTOR     — Cls(printer, gcmd, cb); the reads are in __init__.
  * DELEGATE_AMBIGUOUS— the method name is defined TWICE, so resolution
                        would need type inference and must be refused.
  * DELEGATE_AXIS     — 'PREFIX_' + self.<axis> names, with the axis objects
                        built from literal constructor arguments.
"""


class DelegationHelper:
    def __init__(self, config):
        self.speed = config.getfloat('speed', 5.0)

    def collect(self, gcmd):
        gcmd.get_float('PROBE_SPEED', self.speed, above=0.)
        gcmd.get_int('SAMPLES', 1, minval=1)
        gcmd.get('SAMPLES_RESULT', 'average')


class CtorHelper:
    def __init__(self, printer, gcmd, finalize):
        self.printer = printer
        self.finalize = finalize
        self.speed = gcmd.get_float('MANUAL_SPEED', 5.)


class SharedOne:
    def ambiguous(self, gcmd):
        gcmd.get_float('FROM_SHARED_ONE', 1.)


class SharedTwo:
    def ambiguous(self, gcmd):
        gcmd.get_float('FROM_SHARED_TWO', 2.)


class AxisShaper:
    def __init__(self, axis, config):
        self.axis = axis

    def update(self, gcmd):
        axis = self.axis.upper()
        gcmd.get('SHAPER_KIND_' + axis, 'mzv')


class DelegationCommands:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.gcode = self.printer.lookup_object('gcode')
        self.helper = DelegationHelper(config)
        self.thing = SharedOne()
        self.shapers = [AxisShaper('x', config),
                        AxisShaper('y', config),
                        AxisShaper('z', config)]
        self.gcode.register_command('DELEGATE_METHOD', self.cmd_DELEGATE_METHOD)
        self.gcode.register_command('DELEGATE_CTOR', self.cmd_DELEGATE_CTOR)
        self.gcode.register_command('DELEGATE_AMBIGUOUS',
                                    self.cmd_DELEGATE_AMBIGUOUS)
        self.gcode.register_command('DELEGATE_AXIS', self.cmd_DELEGATE_AXIS)

    def cmd_DELEGATE_METHOD(self, gcmd):
        return self.helper.collect(gcmd)

    def cmd_DELEGATE_CTOR(self, gcmd):
        CtorHelper(self.printer, gcmd, None)

    def cmd_DELEGATE_AMBIGUOUS(self, gcmd):
        self.thing.ambiguous(gcmd)

    def cmd_DELEGATE_AXIS(self, gcmd):
        for shaper in self.shapers:
            shaper.update(gcmd)


def load_config(config):
    return DelegationCommands(config)
