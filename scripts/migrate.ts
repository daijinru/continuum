import { Store } from "../apps/api/src/db.ts";
const store = new Store();
console.log(store.home, store.all("SELECT * FROM schema_migrations"));
store.close();
