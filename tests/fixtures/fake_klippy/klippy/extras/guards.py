"""Fake extras/guards.py — the param-policies the review round-1 flagged.

Review F1 (guarded one-of families marked required) and F2 (params
harvested from NON-gcmd receivers), as pinned micro-shapes:

  GUARDED  — skew_correction/MANUAL_STEPPER/SERVO test-then-read and
             if/elif-action-chain shapes: every read is either guarded
             by a default or sits inside a conditional body, so the
             command is never REQUIRED on any of these names.
  ALIASED  — gcmd reached through an assignment alias (harvested,
             top-level bare read REQUIRED), plus a non-gcmd receiver
             (self.printer.get_start_args().get(...)) that is a dict
             lookup, NOT a command parameter, and a defaulted read.
"""


class _FakePrinter:
    def get_start_args(self):
        return {}


class GuardPrinter:
    # AST-only fixture (the generator parses, never executes); declared so
    # static analysis stays quiet like the other fake files.
    printer = _FakePrinter()
    cmd_GUARDED_help = "guarded fixture"

    def cmd_GUARDED(self, gcmd):
        if gcmd.get('LOAD', None) is not None:
            name = gcmd.get('LOAD')          # bare read, guarded by the test
            self.load(name)
        elif gcmd.get('SAVE', None) is not None:
            self.save(gcmd.get('SAVE'))
        else:
            mode = gcmd.get('FALLBACK')      # action-chain bare read
            self.apply(mode)

    def cmd_ALIASED(self, cmd):
        g = cmd                               # alias of the gcmd parameter
        must = g.get_int('MUST')              # top-level bare: required
        maybe = self.printer.get_start_args().get('debugoutput')  # not gcmd
        delay = cmd.get_float('DELAY', 1.0)   # default: optional
        _ = (must, maybe, delay)

    # no-op sinks so the handler reads stay "used" under lint
    def load(self, name): pass
    def save(self, name): pass
    def apply(self, mode): pass


def load_config(config):
    p = GuardPrinter()
    gcode = config.get_printer().lookup_object('gcode')
    gcode.register_command('GUARDED', p.cmd_GUARDED, desc=p.cmd_GUARDED_help)
    gcode.register_command('ALIASED', p.cmd_ALIASED)
