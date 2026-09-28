import { PrismaClient, Prisma, Role, DataScope, ProductCategory, PriceLevelType, CustomerType, SettlementType, SignMode, OnboardingStatus, LicenseStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = bcrypt.hashSync("demo1234", 10);

  await prisma.$transaction(async (tx) => {
    // ─── 1. 租户 ───
    const tenant = await tx.tenant.upsert({
      where: { code: "TENANT-DEMO" },
      update: {},
      create: {
        code: "TENANT-DEMO",
        name: "示例酒行",
      },
    });

    // ─── 2. 用户 ───
    const usersData: Array<{
      username: string;
      name: string;
      role: Role;
      dataScope: DataScope;
      passwordHash?: string;
      customerId?: string;
    }> = [
      { username: "owner", name: "朱总(老板)", role: "OWNER", dataScope: "ALL", passwordHash },
      { username: "clerk", name: "小王(内勤)", role: "CLERK", dataScope: "ALL", passwordHash },
      { username: "rep1", name: "李业务员", role: "REP", dataScope: "OWN_CUSTOMERS", passwordHash },
      { username: "warehouse", name: "老张(仓管)", role: "WAREHOUSE", dataScope: "SELF", passwordHash },
      { username: "cust-c0001", name: "张三(客户登录)", role: "CUSTOMER", dataScope: "SELF_ORDER", passwordHash },
    ];

    const userMap: Record<string, string> = {};
    for (const u of usersData) {
      const user = await tx.user.upsert({
        where: { tenantId_username: { tenantId: tenant.id, username: u.username } },
        update: {},
        create: {
          tenantId: tenant.id,
          username: u.username,
          name: u.name,
          role: u.role,
          dataScope: u.dataScope,
          passwordHash: u.passwordHash,
          status: "ACTIVE",
          tokenVersion: 0,
        },
      });
      userMap[u.username] = user.id;
    }

    const ownerId = userMap["owner"];
    const clerkId = userMap["clerk"];
    const rep1Id = userMap["rep1"];

    // ─── 3. 商品 ───
    const productsData: Array<{
      skuCode: string;
      name: string;
      category: ProductCategory;
      brand: string;
      packSize: number;
      abv: number | null;
      origin: string;
      specText: string;
      highValue: boolean;
      barcode: string | null;
      pinyinFirst: string;
    }> = [
      { skuCode: "SKU0001", name: "飞天茅台53度500ml", category: "BAIJIU", brand: "茅台", packSize: 6, abv: 53, origin: "贵州", specText: "500ml×6", highValue: true, barcode: "6900000000001", pinyinFirst: "F" },
      { skuCode: "SKU0002", name: "五粮液52度500ml", category: "BAIJIU", brand: "五粮液", packSize: 6, abv: 52, origin: "四川", specText: "500ml×6", highValue: true, barcode: "6900000000002", pinyinFirst: "W" },
      { skuCode: "SKU0003", name: "青岛啤酒500ml", category: "PIJIU", brand: "青岛", packSize: 12, abv: 4.0, origin: "山东", specText: "500ml×12", highValue: false, barcode: "6900000000003", pinyinFirst: "Q" },
      { skuCode: "SKU0004", name: "雪花啤酒8度500ml", category: "PIJIU", brand: "雪花", packSize: 12, abv: 8.0, origin: "辽宁", specText: "500ml×12", highValue: false, barcode: "6900000000004", pinyinFirst: "X" },
      { skuCode: "SKU0005", name: "张裕解百纳750ml", category: "HONGJIU", brand: "张裕", packSize: 6, abv: 12.5, origin: "山东", specText: "750ml×6", highValue: false, barcode: "6900000000005", pinyinFirst: "Z" },
      { skuCode: "SKU0006", name: "轩尼诗VSOP700ml", category: "YANGJIU", brand: "轩尼诗", packSize: 6, abv: 40, origin: "法国", specText: "700ml×6", highValue: true, barcode: "6900000000006", pinyinFirst: "X" },
      { skuCode: "SKU0007", name: "农夫山泉550ml", category: "YINLIAO", brand: "农夫山泉", packSize: 24, abv: null, origin: "浙江", specText: "550ml×24", highValue: false, barcode: "6900000000007", pinyinFirst: "N" },
      { skuCode: "SKU0008", name: "散装塑料周转箱", category: "QITA", brand: "通用", packSize: 1, abv: null, origin: "四川", specText: "单个", highValue: false, barcode: null, pinyinFirst: "S" },
    ];

    const productMap: Record<string, string> = {};
    for (const p of productsData) {
      const product = await tx.product.upsert({
        where: { tenantId_skuCode: { tenantId: tenant.id, skuCode: p.skuCode } },
        update: {},
        create: {
          tenantId: tenant.id,
          skuCode: p.skuCode,
          name: p.name,
          category: p.category,
          brand: p.brand,
          baseUnit: "箱",
          minUnit: "瓶",
          packSize: p.packSize,
          barcode: p.barcode,
          abv: p.abv,
          origin: p.origin,
          specText: p.specText,
          highValue: p.highValue,
          status: "ON_SALE",
          pinyinFirst: p.pinyinFirst,
        },
      });
      productMap[p.skuCode] = product.id;
    }

    // ─── 4. 五级价 ───
    const priceData: Record<string, [number, number, number, number, number]> = {
      SKU0001: [2600, 2900, 3100, 3280, 3680],
      SKU0002: [850, 950, 1020, 1080, 1280],
      SKU0003: [48, 56, 62, 68, 96],
      SKU0004: [42, 50, 55, 60, 84],
      SKU0005: [120, 145, 160, 175, 228],
      SKU0006: [720, 820, 880, 950, 1280],
      SKU0007: [24, 30, 33, 36, 48],
      SKU0008: [15, 18, 20, 22, 30],
    };

    const levelTypes: PriceLevelType[] = ["COST", "TIER1", "TIER2", "TERMINAL", "RETAIL"];
    const validFrom = new Date("2026-09-01");

    for (const [skuCode, prices] of Object.entries(priceData)) {
      const productId = productMap[skuCode];
      for (let i = 0; i < 5; i++) {
        await tx.price.upsert({
          where: {
            tenantId_productId_unit_levelType_validFrom: {
              tenantId: tenant.id,
              productId,
              unit: "BASE",
              levelType: levelTypes[i],
              validFrom,
            },
          },
          update: {},
          create: {
            tenantId: tenant.id,
            productId,
            unit: "BASE",
            levelType: levelTypes[i],
            price: prices[i],
            validFrom,
            createdBy: ownerId,
          },
        });
      }
    }

    // ─── 5. 客户 ───
    const customersData: Array<{
      code: string;
      name: string;
      type: CustomerType;
      contact: string;
      phone: string;
      settlement: SettlementType;
      termsDays: number;
      creditLimit: number;
      minOrderAmount: number;
      signMode: SignMode;
      abcLevel: string | null;
      salespersonId: string;
      onboarding: OnboardingStatus;
      licenseStatus: LicenseStatus;
      address: string;
    }> = [
      { code: "C0001", name: "张三烟酒店", type: "YANJIUDIAN", contact: "张三", phone: "13800000001", settlement: "MONTHLY", termsDays: 30, creditLimit: 20000, minOrderAmount: 200, signMode: "E_SIGN", abcLevel: "A", salespersonId: rep1Id, onboarding: "ACTIVE", licenseStatus: "OK", address: "浙江省杭州市西湖区文三路100号" },
      { code: "C0002", name: "王五超市", type: "CHAOSHI", contact: "王五", phone: "13800000002", settlement: "MONTHLY", termsDays: 30, creditLimit: 50000, minOrderAmount: 500, signMode: "E_SIGN", abcLevel: "A", salespersonId: rep1Id, onboarding: "ACTIVE", licenseStatus: "OK", address: "浙江省杭州市拱墅区莫干山路200号" },
      { code: "C0003", name: "老四川火锅", type: "CANYIN", contact: "刘老板", phone: "13800000003", settlement: "MONTHLY", termsDays: 15, creditLimit: 30000, minOrderAmount: 300, signMode: "PAPER", abcLevel: "B", salespersonId: rep1Id, onboarding: "ACTIVE", licenseStatus: "OK", address: "四川省成都市锦江区春熙路50号" },
      { code: "C0004", name: "县城批发大王", type: "PIFA", contact: "陈老板", phone: "13800000004", settlement: "MONTHLY", termsDays: 30, creditLimit: 100000, minOrderAmount: 1000, signMode: "E_SIGN", abcLevel: "A", salespersonId: ownerId, onboarding: "ACTIVE", licenseStatus: "OK", address: "湖南省长沙市岳麓区解放路88号" },
      { code: "C0005", name: "便利店101", type: "YANJIUDIAN", contact: "小赵", phone: "13800000005", settlement: "CASH", termsDays: 0, creditLimit: 0, minOrderAmount: 100, signMode: "PAPER", abcLevel: "C", salespersonId: rep1Id, onboarding: "ACTIVE", licenseStatus: "OK", address: "江苏省南京市鼓楼区中山北路300号" },
      { code: "C0006", name: "市政招待所", type: "QIYE", contact: "孙主任", phone: "13800000006", settlement: "MONTHLY", termsDays: 60, creditLimit: 20000, minOrderAmount: 200, signMode: "E_SIGN", abcLevel: "B", salespersonId: rep1Id, onboarding: "ACTIVE", licenseStatus: "OK", address: "湖北省武汉市武昌区中南路120号" },
      { code: "C0007", name: "新客待审酒行", type: "YANJIUDIAN", contact: "钱老板", phone: "13800000007", settlement: "MONTHLY", termsDays: 30, creditLimit: 5000, minOrderAmount: 200, signMode: "E_SIGN", abcLevel: null, salespersonId: rep1Id, onboarding: "REP_DRAFT", licenseStatus: "PENDING", address: "广东省广州市天河区体育西路100号" },
    ];

    const customerMap: Record<string, string> = {};
    for (const c of customersData) {
      const customer = await tx.customer.upsert({
        where: { tenantId_code: { tenantId: tenant.id, code: c.code } },
        update: {},
        create: {
          tenantId: tenant.id,
          code: c.code,
          name: c.name,
          type: c.type,
          contact: c.contact,
          phone: c.phone,
          address: c.address,
          abcLevel: c.abcLevel,
          settlement: c.settlement,
          termsDays: c.termsDays,
          creditLimit: c.creditLimit,
          minOrderAmount: c.minOrderAmount,
          signMode: c.signMode,
          salespersonId: c.salespersonId,
          onboarding: c.onboarding,
          licenseStatus: c.licenseStatus,
          status: "ACTIVE",
        },
      });
      customerMap[c.code] = customer.id;
    }

    // 绑定客户登录用户
    const custUser = await tx.user.findUnique({
      where: { tenantId_username: { tenantId: tenant.id, username: "cust-c0001" } },
    });
    if (custUser) {
      await tx.user.update({
        where: { id: custUser.id },
        data: { customerId: customerMap["C0001"] },
      });
    }

    // ─── 6. 客户专属价 ───
    const customerPricesData: Array<{
      customerId: string;
      productId: string;
      price: number;
      approvalRef: string;
    }> = [
      { customerId: customerMap["C0001"], productId: productMap["SKU0001"], price: 3050, approvalRef: "AP2026001" },
      { customerId: customerMap["C0002"], productId: productMap["SKU0003"], price: 60, approvalRef: "AP2026002" },
    ];

    for (const cp of customerPricesData) {
      await tx.customerPrice.upsert({
        where: {
          tenantId_customerId_productId_unit_validFrom: {
            tenantId: tenant.id,
            customerId: cp.customerId,
            productId: cp.productId,
            unit: "BASE",
            validFrom,
          },
        },
        update: {},
        create: {
          tenantId: tenant.id,
          customerId: cp.customerId,
          productId: cp.productId,
          unit: "BASE",
          price: cp.price,
          validFrom,
          approvalRef: cp.approvalRef,
          createdBy: ownerId,
        },
      });
    }

    // ─── 7. 期初库存批次 + 库存流水 ───
    const snapshotDate = new Date("2026-09-30");
    const produceDate = new Date("2026-08-01");
    const expiryDate = new Date("2026-11-01");

    const batchesData: Array<{
      skuCode: string;
      batchNo: string;
      produceDate: Date | null;
      expiryDate: Date | null;
      location: string;
      unitCost: number;
      qty: number;
    }> = [
      { skuCode: "SKU0001", batchNo: "期初", produceDate: null, expiryDate: null, location: "锁区A-01", unitCost: 433, qty: 360 },
      { skuCode: "SKU0002", batchNo: "期初", produceDate: null, expiryDate: null, location: "锁区A-01", unitCost: 142, qty: 720 },
      { skuCode: "SKU0003", batchNo: "PIJIU-20260801", produceDate, expiryDate, location: "A-01", unitCost: 4.0, qty: 2880 },
      { skuCode: "SKU0004", batchNo: "PIJIU-20260801", produceDate, expiryDate, location: "A-01", unitCost: 3.5, qty: 2880 },
      { skuCode: "SKU0005", batchNo: "期初", produceDate: null, expiryDate: null, location: "A-01", unitCost: 20, qty: 720 },
      { skuCode: "SKU0006", batchNo: "期初", produceDate: null, expiryDate: null, location: "锁区A-01", unitCost: 120, qty: 360 },
      { skuCode: "SKU0007", batchNo: "期初", produceDate: null, expiryDate: null, location: "A-01", unitCost: 1.0, qty: 4800 },
      { skuCode: "SKU0008", batchNo: "期初", produceDate: null, expiryDate: null, location: "A-01", unitCost: 15, qty: 100 },
    ];

    for (const b of batchesData) {
      const productId = productMap[b.skuCode];
      const batch = await tx.batchStock.upsert({
        where: { tenantId_productId_batchNo: { tenantId: tenant.id, productId, batchNo: b.batchNo } },
        update: {},
        create: {
          tenantId: tenant.id,
          productId,
          batchNo: b.batchNo,
          produceDate: b.produceDate,
          expiryDate: b.expiryDate,
          location: b.location,
          unitCost: b.unitCost,
          snapshotDate,
          isInitial: true,
        },
      });

      // 检查是否已有流水, 避免重复
      const existingLedger = await tx.inventoryLedger.findFirst({
        where: {
          tenantId: tenant.id,
          batchId: batch.id,
          refType: "INITIAL_IMPORT",
          direction: "IN",
        },
      });

      if (!existingLedger) {
        await tx.inventoryLedger.create({
          data: {
            tenantId: tenant.id,
            productId,
            batchId: batch.id,
            direction: "IN",
            qty: b.qty,
            refType: "INITIAL_IMPORT",
            refNo: b.batchNo,
            createdBy: ownerId,
          },
        });
      }
    }

    // ─── 8. 期初应收 ───
    const receivablesData: Array<{
      sourceDocNo: string;
      customerCode: string;
      total: number;
      dueDate: string;
      disputeFlag: boolean;
      note?: string;
    }> = [
      { sourceDocNo: "初0001", customerCode: "C0001", total: 5600, dueDate: "2026-09-14", disputeFlag: false },
      { sourceDocNo: "初0002", customerCode: "C0003", total: 12800, dueDate: "2026-08-20", disputeFlag: false },
      { sourceDocNo: "初0003", customerCode: "C0002", total: 30000, dueDate: "2026-06-30", disputeFlag: false },
      { sourceDocNo: "初0004", customerCode: "C0006", total: 8000, dueDate: "2026-05-15", disputeFlag: true, note: "期初-争议:单据不清" },
    ];

    for (const r of receivablesData) {
      const customerId = customerMap[r.customerCode];
      const receivable = await tx.receivable.upsert({
        where: { tenantId_sourceType_sourceDocNo: { tenantId: tenant.id, sourceType: "INITIAL", sourceDocNo: r.sourceDocNo } },
        update: {},
        create: {
          tenantId: tenant.id,
          sourceType: "INITIAL",
          sourceDocNo: r.sourceDocNo,
          customerId,
          total: r.total,
          dueDate: new Date(r.dueDate),
          disputeFlag: r.disputeFlag,
          note: r.note,
        },
      });

      // 检查是否已有 CHARGE 流水
      const existingLedger = await tx.receivableLedger.findFirst({
        where: {
          tenantId: tenant.id,
          receivableId: receivable.id,
          direction: "CHARGE",
        },
      });

      if (!existingLedger) {
        await tx.receivableLedger.create({
          data: {
            tenantId: tenant.id,
            receivableId: receivable.id,
            direction: "CHARGE",
            amount: r.total,
            createdBy: clerkId,
          },
        });
      }
    }
  });

  console.log("Seed completed successfully.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
