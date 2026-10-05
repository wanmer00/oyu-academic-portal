// `prisma db seed` / `npm run seed`: заполняет ПУСТУЮ базу демонстрационными данными.
// Для полного восстановления демо-базы используйте `npm run demo:reset`.
import { PrismaClient } from '@prisma/client';
import { seedDemo } from '../src/demo/demo-seed';

const prisma = new PrismaClient();

async function main() {
  if ((await prisma.user.count()) > 0) {
    console.log('Database is not empty — skipping seed. Use `npm run demo:reset` to restore the demo dataset.');
    return;
  }
  console.log('Seeding Academic Portal demo dataset...');
  const summary = await seedDemo(prisma);
  console.log('Done:', summary);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());