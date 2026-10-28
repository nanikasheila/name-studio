// A heavy name for the timing tests (perf.mjs, pen.mjs, endurance.mjs): pages
// each with panels, dialogue in balloons and wavy rough lines, the same every
// time; opened in the editor at page `show`.

/**
 * Fill a new project with the heavy name's pages: `m` holds the app's
 * functions (project.ts, panels.ts, dialogue.ts, geometry.ts, pagebox.ts),
 * so the same name is made in the page and in Node (feel.mjs writes it to a file).
 */
export function fillHeavy(m, { pages = 32, strokes = 200 } = {}) {
  const project = m.newProject("重いネーム", pages);
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let id = 0;
  for (const p of project.pages) {
    m.addPanel(project, p, m.rectShape(m.basicBox(project.pageFormat)));
    m.cutPanels(project, p, [40, 160], [260, 162]);
    m.cutPanels(project, p, [40, 260], [260, 258]);
    m.cutPanels(project, p, [150, 60], [149, 155]);
    for (let l = 0; l < 8; l++) {
      const line = m.addLine(project, p, [80 + (l % 4) * 40, 90 + Math.floor(l / 4) * 120]);
      m.setLineText(line, "ここで\nセリフが入る");
    }
    for (let s = 0; s < strokes; s++) {
      let [x, y, a] = [20 + random() * 200, 20 + random() * 300, random() * 6.28];
      const points = [];
      for (let i = 0; i < 50; i++) {
        a += (random() - 0.5) * 0.5;
        x += Math.cos(a) * 0.4;
        y += Math.sin(a) * 0.4;
        points.push([x, y, 0.3 + 0.6 * Math.sin((Math.PI * i) / 50)]);
      }
      p.strokes.push({ id: `s${id++}`, points, widthMm: 0.5, closed: false });
    }
  }
  project.nextId += id + 1000;
  return project;
}

/** Open the heavy name in the page (the app with nameStudio, e2e/tauri-mock.js); returns how long showing it took (ms). */
export function openHeavyName(page, { pages = 32, strokes = 200, show = 10 } = {}) {
  return page.evaluate(`(async () => {
    const m = {
      ...(await import("/src/project.ts")),
      ...(await import("/src/panels.ts")),
      ...(await import("/src/dialogue.ts")),
      ...(await import("/src/geometry.ts")),
      ...(await import("/src/pagebox.ts")),
    };
    const project = (${fillHeavy.toString()})(m, ${JSON.stringify({ pages, strokes })});
    const start = performance.now();
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(${Number(show)});
    wb.editor.draw();
    return performance.now() - start;
  })()`);
}
