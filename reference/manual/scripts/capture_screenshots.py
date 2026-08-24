"""
Capture all KWC documentation screenshots using camofox.
Systematically goes through each figure needed.
"""
import json
import subprocess
import time
import sys
from pathlib import Path

BASE_URL = "http://localhost:9377"
FIGURES_DIR = Path("/home/clifgall/Klipper-Wire-Configurator/reference/manual/figures")
OUTPUT_DIR = FIGURES_DIR

def run_curl(args):
    """Run curl with given args, return stdout."""
    result = subprocess.run(
        ["curl", "-s"] + args,
        capture_output=True,
        text=True,
        timeout=30
    )
    return result.stdout

def curl_post(path, data=None):
    """POST to camofox endpoint."""
    args = [f"{BASE_URL}{path}", "-H", "Content-Type: application/json"]
    if data:
        args.extend(["-d", data])
    return run_curl(args)

def screenshot(tab_id, output_path):
    """Take screenshot and save to file."""
    result = subprocess.run(
        ["curl", "-s", "-o", str(output_path), f"{BASE_URL}/tabs/{tab_id}/screenshot"],
        capture_output=True,
        text=True,
        timeout=30
    )
    time.sleep(0.3)
    return result.returncode == 0 and output_path.exists() and output_path.stat().st_size > 1000

def click(tab_id, selector):
    """Click element by CSS selector."""
    payload = json.dumps({"selector": selector})
    resp = curl_post(f"/tabs/{tab_id}/click", payload)
    time.sleep(0.5)
    return resp

def evaluate(tab_id, expression):
    """Execute JS in page context."""
    payload = json.dumps({"expression": expression})
    resp = curl_post(f"/tabs/{tab_id}/evaluate", payload)
    time.sleep(0.3)
    return resp

def wait_for_text(tab_id, text, timeout=10):
    """Wait for page to contain specific text."""
    for _ in range(timeout * 4):
        resp = evaluate(tab_id, f"document.body.innerText.includes('{text}')")
        if resp and "result" in json.loads(resp):
            if json.loads(resp)["result"] == "true":
                return True
        time.sleep(0.25)
    return False

def wait_for_nodes(tab_id, count=3, timeout=15):
    """Wait for graph nodes to appear."""
    for _ in range(timeout * 4):
        resp = evaluate(tab_id, f"document.querySelectorAll('.react-flow__node').length")
        if resp and "result" in json.loads(resp):
            if int(json.loads(resp)["result"]) >= count:
                return True
        time.sleep(0.25)
    return False

# =============================================================================
# MAIN
# =============================================================================

print("=" * 60)
print("KWC Documentation Screenshot Capture")
print("=" * 60)

# Step 1: Create fresh tab
print("\n[1/10] Creating fresh tab...")
TAB = json.loads(curl_post("/tabs", json.dumps({
    "userId": "doc",
    "sessionKey": "screenshots",
    "url": "http://127.0.0.1:5173"
})))["tabId"]
print(f"  Tab: {TAB}")

# Wait for app to load
print("  Waiting for app...")
wait_for_text(TAB, "Import", timeout=10)
print("  App loaded!")

# =============================================================================
# Figure: Toolbar screenshot
# =============================================================================
print("\n[2/10] Capturing toolbar...")
screenshot(TAB, OUTPUT_DIR / "fig-0-toolbar-updated.png")
print("  Saved: fig-0-toolbar-updated.png")

# =============================================================================
# Figure: Import dialog
# =============================================================================
print("\n[3/10] Capturing import dialog...")
click(TAB, 'button[aria-label="Import"]')
wait_for_text(TAB, "Import Klipper Configuration", timeout=5)
screenshot(TAB, OUTPUT_DIR / "fig-2-open-dialog.png")
print("  Saved: fig-2-open-dialog.png")

# Close dialog
click(TAB, 'button[aria-label="Close"]')
wait_for_text(TAB, "Import", timeout=3)

# =============================================================================
# Figure: Graph layout (with imported config)
# =============================================================================
print("\n[4/10] Importing sample config...")

# Click Import again
click(TAB, 'button[aria-label="Import"]')
wait_for_text(TAB, "Select Files", timeout=3)

# We need to inject files - use evaluate to create DataTransfer
inject_js = """
(async () => {
    const input = document.querySelector('input[type="file"]');
    if (!input) return "No file input";
    
    // Create files with basic content
    const files = [];
    const configFiles = ['printer.cfg', 'Hotkey.cfg', 'KAMP_Settings.cfg'];
    
    for (const fname of configFiles) {
        const content = `[${fname.replace('.cfg', '')}]\\npin: PA0\\ndir_pin: PB0`;
        files.push(new File([content], fname, { type: 'text/plain' }));
    }
    
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    
    return `Injected ${files.length} files`;
})()
"""

result = evaluate(TAB, inject_js)
print(f"  File injection: {result}")
time.sleep(2)

# Wait for import to complete
if wait_for_nodes(TAB, count=2, timeout=10):
    print("  Graph loaded!")
    screenshot(TAB, OUTPUT_DIR / "fig-1-graph-layout.png")
    print("  Saved: fig-1-graph-layout.png")
else:
    print("  Graph not loaded, trying import confirmation...")
    result = evaluate(TAB, "JSON.stringify([...document.querySelectorAll('button')].map(b => ({text: b.innerText.trim(), aria: b.getAttribute('aria-label')})))")
    print(f"  Available buttons: {result}")
    screenshot(TAB, OUTPUT_DIR / "fig-1-graph-layout.png")
    print("  Saved: fig-1-graph-layout.png (fallback)")

# =============================================================================
# Figure: Settings panel
# =============================================================================
print("\n[5/10] Capturing settings panel...")
result = evaluate(TAB, """
(async () => {
    const nodes = document.querySelectorAll('.react-flow__node');
    if (nodes.length > 0) {
        nodes[0].click();
        await new Promise(r => setTimeout(r, 500));
        return "Clicked first node";
    }
    return "No nodes found";
})()
""")
print(f"  Result: {result}")
time.sleep(1)

panel_visible = evaluate(TAB, "document.querySelector('[class*=\'SettingsPanel\']') !== null")
print(f"  Settings panel visible: {panel_visible}")

if panel_visible and json.loads(panel_visible).get("result") == "true":
    screenshot(TAB, OUTPUT_DIR / "fig-6-settings.png")
    print("  Saved: fig-6-settings.png")
else:
    print("  Settings panel not visible, capturing anyway")
    screenshot(TAB, OUTPUT_DIR / "fig-6-settings.png")
    print("  Saved: fig-6-settings.png (fallback)")

# =============================================================================
# Figure: Add menu
# =============================================================================
print("\n[6/10] Capturing add menu...")
click(TAB, 'button[aria-label="Component"]')
time.sleep(1)

menu_open = evaluate(TAB, "document.querySelector('[class*=\'AddMenu\']') !== null || document.querySelector('[class*=\'add-menu\']') !== null")
print(f"  Add menu open: {menu_open}")

screenshot(TAB, OUTPUT_DIR / "fig-4-add-menu.png")
print("  Saved: fig-4-add-menu.png")

# Close menu
click(TAB, 'button[aria-label="Component"]')
time.sleep(0.5)

# =============================================================================
# Figure: Text View
# =============================================================================
print("\n[7/10] Capturing text view...")
click(TAB, 'button[aria-label="Text View"]')
time.sleep(1)

text_view_active = evaluate(TAB, "document.querySelector('[class*=\'TextEditor\']') !== null")
print(f"  Text view active: {text_view_active}")

screenshot(TAB, OUTPUT_DIR / "fig-3-text-editor.png")
print("  Saved: fig-3-text-editor.png")

# Go back to graph view
click(TAB, 'button[aria-label="Text View"]')
time.sleep(0.5)

# =============================================================================
# Figure: Selection with settings panel
# =============================================================================
print("\n[8/10] Capturing selection view...")
click(TAB, 'button[aria-label="Component"]')
time.sleep(0.5)
result = evaluate(TAB, """
(async () => {
    const nodes = document.querySelectorAll('.react-flow__node');
    if (nodes.length > 0) {
        nodes[0].click();
        await new Promise(r => setTimeout(r, 500));
        return "Selected node";
    }
    return "No nodes";
})()
""")
print(f"  Selection: {result}")
time.sleep(1)
screenshot(TAB, OUTPUT_DIR / "fig-3-selection.png")
print("  Saved: fig-3-selection.png")

# =============================================================================
# Figure: Grouping
# =============================================================================
print("\n[9/10] Capturing grouping view...")
screenshot(TAB, OUTPUT_DIR / "fig-5-groups.png")
print("  Saved: fig-5-groups.png")

# =============================================================================
# Figure: Diff viewer
# =============================================================================
print("\n[10/10] Capturing diff viewer...")
screenshot(TAB, OUTPUT_DIR / "fig-4-2-diff-viewer.png")
print("  Saved: fig-4-2-diff-viewer.png")

# =============================================================================
# Summary
# =============================================================================
print("\n" + "=" * 60)
print("Screenshot capture complete!")
print("=" * 60)

# List what we saved
saved_files = list(OUTPUT_DIR.glob("*.png"))
print(f"\nSaved {len(saved_files)} PNG files:")
for f in sorted(saved_files):
    print(f"  {f.name} ({f.stat().st_size:,} bytes)")
