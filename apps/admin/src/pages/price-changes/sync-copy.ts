export function customerSyncLabel(record: {
  customerSync: boolean;
  customerSyncResult?: { customers: number } | null;
}): string {
  if (record.customerSyncResult) {
    return `已平移 ${record.customerSyncResult.customers} 个客户的专属价`;
  }
  return record.customerSync ? '生效时联动' : '不联动';
}
