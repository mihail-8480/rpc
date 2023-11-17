import { client, createClientDriver, params, server } from "./lib";

interface CounterContext {
  counter: number;
}

interface CounterInterface {
  increment(ctx: CounterContext, amount: number): number;
  decrement(ctx: CounterContext, amount: number): number;
}
const localDriver = createClientDriver(
  server<CounterContext>(
    {
      increment(ctx, ...p): number {
        const [amount] = params(p, "number");
        ctx.counter += amount;
        return ctx.counter;
      },
      decrement(ctx, ...p): number {
        const [amount] = params(p, "number");
        ctx.counter -= amount;
        return ctx.counter;
      },
    },
    async () => ({ counter: 0 })
  )
);

async function main() {
  const rpc = client<CounterInterface>(localDriver);
  return await rpc.batch.notify
    .decrement(2)
    .notify.decrement(2)
    .notify.increment(4)
    .increment(10)
    .send();
}

main().then().catch(console.error);
