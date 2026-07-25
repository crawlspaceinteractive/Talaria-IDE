export function createPayments() {
  return {
    prompt(productKey) {
      console.log('[Payments] prompt', productKey);
      return Promise.resolve(false);
    },
  };
}
