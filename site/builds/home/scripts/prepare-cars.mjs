// Prepares every car in cars.config.json for the web and writes public/models/cars.json, the
// list the page reads: each car's name, team and season, the prepared model it uses, the yaw
// that turns its nose to -X, and the model's credit (CC BY needs one on the page).
//
//   node scripts/prepare-cars.mjs            prepares any model not prepared yet
//   node scripts/prepare-cars.mjs --again    prepares them all again
import fs from "node:fs";
import { prepare } from "./prepare-model.mjs";

const config = JSON.parse(fs.readFileSync("cars.config.json", "utf8"));
const again = process.argv.includes("--again");
fs.mkdirSync("public/models", { recursive: true });
const prepared = new Map(); // source file -> { file, yaw, credit }
const cars = [];
for (const car of config.cars) {
  if (!prepared.has(car.model)) {
    const source = `models/source/${car.model}`;
    if (!fs.existsSync(source)) {
      console.log(`  ${car.id}: no ${source}, skipped`);
      continue;
    }
    const file = `models/${car.model}`;
    const meta = `public/models/${car.model}.json`;
    let info;
    if (!again && fs.existsSync(`public/${file}`) && fs.existsSync(meta)) {
      info = JSON.parse(fs.readFileSync(meta, "utf8"));
    } else {
      console.log(`Preparing ${car.model}`);
      const r = await prepare(source, `public/${file}`);
      const x = r.extras;
      info = {
        yaw: r.yaw,
        credit: { title: x.title, author: String(x.author ?? "").replace(/\s*\(.*\)$/, ""), url: x.source, license: "CC BY 4.0" },
      };
      fs.writeFileSync(meta, JSON.stringify(info, null, 1));
      console.log(`  nose ${r.noseAtMax ? "+" : "-"}${r.axis}, yaw ${r.yaw.toFixed(3)}, ${(fs.statSync(`public/${file}`).size / 1e6).toFixed(1)} MB`);
    }
    prepared.set(car.model, { file, ...info });
  }
  const p = prepared.get(car.model);
  cars.push({ id: car.id, name: car.name, team: car.team, season: car.season, model: p.file, yaw: p.yaw, borrowed: !!car.borrowed, credit: p.credit });
}
fs.writeFileSync("public/models/cars.json", JSON.stringify({ cars }, null, 1));
console.log(`public/models/cars.json: ${cars.length} cars`);
