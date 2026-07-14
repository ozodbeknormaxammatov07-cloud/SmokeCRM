# Tamaki Savdo — kundalik qo'llanma

Bir sahifalik yo'riqnoma. Telefon yoki kompyuterda ishlaydi.
Pastdagi (telefon) yoki chapdagi (kompyuter) menyu: **Boshqaruv · Sotuv · Kirim · Mahsulotlar · Hisobot**.

---

## 1. Sotuvni yozish (eng ko'p ishlatiladigan amal)

1. **Sotuv** bo'limini oching.
2. Qidiruv oynasiga mahsulot nomini yozing (yoki shtrix-kodni skanerlang).
3. Ro'yxatdan mahsulotni **bosing** — u savatga tushadi.
4. Sonini `−` / `+` tugmalari bilan yoki qo'lda o'zgartiring.
5. Bir nechta mahsulot sotilsa — qadamlarni takrorlang, hammasi bitta savatga yig'iladi.
6. Pastda **Jami** summa va **Kutilayotgan foyda** ko'rinib turadi.
7. **"Sotuvni tasdiqlash"** tugmasini bosing.

Shu zahoti: qoldiq kamayadi, foyda hisoblanadi, yozuv tarixga tushadi.

> **Narx.** Sotish narxi avtomatik qo'yiladi. Chegirma qilsangiz — narx maydonini
> o'zgartiring, foyda o'zi qayta hisoblanadi.
>
> **Qoldiqdan ko'p sota olmaysiz.** Omborda 5 dona bo'lsa, 6 dona sotib bo'lmaydi —
> tizim qizil rangda ogohlantiradi va tugmani bloklaydi.

---

## 2. Kirimni yozish (yangi tovar kelganda)

1. **Kirim** bo'limini oching.
2. Mahsulotni toping va bosing.
3. **Nechta** kelganini kiriting.
4. **Kelish narxini** kiriting (narx o'zgargan bo'lsa — yangisini yozing).
5. **"Kirimni tasdiqlash"**.

Qoldiq oshadi. Agar kelish narxini o'zgartirgan bo'lsangiz, mahsulotning tan narxi
ham yangilanadi — keyingi sotuvlarda foyda yangi narxdan hisoblanadi.

---

## 3. Boshqaruv panelini o'qish

Yuqorida davr tanlanadi: **Bugun / 7 kun / 30 kun**.

| Karta | Ma'nosi |
|---|---|
| **Tushum** | Shu davrda sotuvdan tushgan umumiy pul |
| **Foyda** | (sotish narxi − kelish narxi) × sotilgan soni. Pastida marja % |
| **Sotilgan** | Nechta dona ketgan |
| **Kam qolgan** | Nechta mahsulotni buyurtma qilish kerak |

Pastda:
- **Eng ko'p sotilganlar** — qaysi mahsulot yaxshi ketyapti.
- **Ombor qiymati** — javondagi tovar qancha pulga teng.
- **🔴 Buyurtma berish kerak** — qizil jadval. Qoldiq minimal zaxiradan kam yoki teng
  bo'lgan hamma mahsulot. **Har kuni ertalab shu jadvalga qarang.**

**Qoldiq ranglari:** 🟢 yashil — yetarli · 🟡 sariq — kam qoldi · 🔴 qizil — tugagan.

---

## 4. Excel faylni import qilish (birinchi ishga tushirish)

1. **Mahsulotlar** → **"📄 Excel import"**.
2. Excel faylingizni tanlang (`.xlsx`, `.xls` yoki `.csv`).
3. Tizim har bir varaqni (UzBat, Parliament, Winston, Esse) alohida o'qiydi va
   **varaq nomini brend sifatida** oladi.
4. Ustunlar avtomatik aniqlanadi. Xato bo'lsa — har bir ustun yonidagi ro'yxatdan
   to'g'risini tanlang (masalan `Sotib olish narxi` → **Kelish narxi**).
5. Har varaq uchun 5 ta namunaviy qator ko'rsatiladi — tekshiring.
6. Qizil bilan belgilangan qatorlar (nomi yoki sotish narxi yo'q) **tashlab ketiladi**.
7. **"Import qilish"**.

Import faqat **qo'shadi**, hech narsani o'chirmaydi. Bazada allaqachon bor mahsulotlar
(shtrix-kod, yoki shtrix-kod bo'lmasa nomi+brendi bo'yicha aniqlanadi) **"bazada bor"**
deb belgilanadi va tashlab ketiladi — shuning uchun bir faylni ikki marta yuklasangiz
ham mahsulotlar takrorlanmaydi.

> Fayl tayyor emasmi? Import oynasidagi **"Bo'sh shablonni yuklab oling"** tugmasini
> bosing — to'g'ri ustunli bo'sh Excel fayl yuklanadi, to'ldirib qaytadan yuklang.

---

## 5. Xatoni tuzatish

**Sotuvni noto'g'ri yozdingizmi?**
**Hisobot** → **"Amallar tarixi"** → kerakli qator → **"Bekor qilish"**.

Yozuv **o'chirilmaydi**. Uning ustidan teskari yozuv qo'shiladi va qoldiq tiklanadi.
Tarixda ikkalasi ham ko'rinib turadi — kim, qachon, nimani bekor qilgani yozib qoladi.

**Qoldiq haqiqatga to'g'ri kelmayaptimi?** (sanab chiqdingiz, tovar shikastlangan)
**Mahsulotlar** → qoldiq raqamini bosing → haqiqiy sonni va **sababini** yozing.
Bu ham tarixda ko'rinadi.

---

## 6. Hisobot va zaxira nusxa

**Hisobot** bo'limida: davrni tanlang (yoki `Dan`/`Gacha` sanalarini qo'ying),
brend bo'yicha filtrlang, kunlik/haftalik/oylik guruhlang.

- **"⬇ Excel'ga eksport"** — hisobotni Excel'ga yuklaydi: xulosa, brendlar,
  mahsulotlar, dinamika va hamma amallar — har biri alohida varaqda.

### 💾 Zaxira nusxa — buni jiddiy qabul qiling

Ma'lumot **faqat shu qurilmaning brauzerida** saqlanadi. Serverda nusxasi yo'q.
Brauzer tarixi/"site data" tozalansa yoki telefon buzilsa — hammasi yo'qoladi.

**"💾 Zaxira nusxa"** tugmasi ikkita fayl beradi:
- `zaxira_2026-07-13.json` — **shu faylni saqlang.** U hamma narsani aynan tiklaydi.
- `zaxira_nusxa_2026-07-13.xlsx` — o'qish uchun.

`.json` faylni OneDrive'ga, Telegram "Saqlangan xabarlar"ga yoki fleshkaga tashlang.
**Haftada bir marta.**

Yangi telefonga o'tsangiz yoki ma'lumot yo'qolsa: **"♻️ Tiklash"** → `.json` faylni
tanlang. Diqqat — tiklash hozirgi hamma ma'lumotni o'chirib, zaxiradagisini qo'yadi.

---

## Muhim qoidalar

- **Foydani qo'lda yozmaysiz.** Faqat kelish va sotish narxini kiritasiz — qolganini
  tizim o'zi hisoblaydi.
- **Qoldiqni qo'lda yozmaysiz.** U faqat sotuv va kirim orqali o'zgaradi.
- **Yozuvlar o'chmaydi.** Xato bo'lsa — bekor qilinadi, lekin tarixda qoladi.
- **Yangi brend qo'shish:** Mahsulotlar → "+ Mahsulot" → brend maydoniga yangi nom yozing.
- **Internet kerak emas.** Tizim to'liq oflayn ishlaydi — hamma narsa shu qurilmada.
- **Doim bitta qurilmada ishlating.** Telefon va kompyuter bir-biri bilan
  bog'lanmaydi — har birida alohida ma'lumot bo'ladi.
- **Zaxira nusxani unutmang** (6-bo'limga qarang). Bu yagona himoya.
