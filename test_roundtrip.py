import sys, glob
sys.path.insert(0, 'backend')
from parser.config_parser import parse_config
from parser.config_writer import smart_export
from pathlib import Path

configs = glob.glob('reference/config/**/*.cfg', recursive=True)
configs += glob.glob('reference/Trident_backup/**/*.cfg', recursive=True)

results = {'perfect': 0, 'close': 0, 'bad': 0}
for cfg_path in sorted(configs):
    try:
        original = Path(cfg_path).read_text(encoding='utf-8')
        config = parse_config(original, Path(cfg_path).name)
        exported = smart_export(config)
        
        if original == exported:
            results['perfect'] += 1
        else:
            orig_lines = original.splitlines()
            exp_lines = exported.splitlines()
            diffs = sum(1 for o, e in zip(orig_lines, exp_lines) if o != e)
            diffs += abs(len(orig_lines) - len(exp_lines))
            if diffs <= 3:
                results['close'] += 1
                print(f'CLOSE ({diffs} diff): {cfg_path}')
            else:
                results['bad'] += 1
                print(f'BAD ({diffs} diff, {len(orig_lines)} -> {len(exp_lines)} lines): {cfg_path}')
                shown = 0
                for i, (o, e) in enumerate(zip(orig_lines, exp_lines)):
                    if o != e and shown < 5:
                        print(f'  Line {i+1}: {repr(o[:60])} -> {repr(e[:60])}')
                        shown += 1
    except Exception as ex:
        print(f'ERROR: {cfg_path}: {ex}')

print(f'\nSummary: {results["perfect"]} perfect, {results["close"]} close (<=3 diffs), {results["bad"]} bad')
print(f'Total files: {len(configs)}')
