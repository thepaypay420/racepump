import { backfillUserResultsFromHistory } from "../server/backfill";

(async () => {
  const res = await backfillUserResultsFromHistory();
  console.log(JSON.stringify(res));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

