# Tamaki Savdo — to'liq qo'llanma va tizim mantig'i

Bu hujjat ikki qismdan iborat:

- **A qism — Foydalanuvchi qo'llanmasi:** har bir bo'limdan qanday foydalanish.
- **B qism — Tizim mantig'i (audit):** tizim ichida qaysi qoidalar ishlaydi, raqamlar
  qanday hisoblanadi, nega ma'lumotga ishonsa bo'ladi.

Menyu (telefonda pastda, kompyuterda chapda) rolga qarab o'zgaradi:
**Boshqaruv · Sotuv · Kirim · Mahsulotlar · Firmalar · Hisobot · Kassa · Xodimlar**.
Kassir faqat **Sotuv** va **Mahsulotlar**ni ko'radi.

---

# A QISM — FOYDALANUVCHI QO'LLANMASI

## 0. Tizimga kirish

Birinchi ochilganda tizim **birinchi administrator** hisobini so'raydi: ism va parol
kiriting. Bu hisob — bosh administrator (do'kon egasi).

Keyin har safar **ism + parol** bilan kiriladi. Kirgan xodim har bir yozuvga avtomatik
"muallif" bo'lib qo'yiladi — kim sotgani, kim kirim qilgani o'zi saqlanadi.

**Ikki xil rol:**

| | Administrator | Kassir |
|---|---|---|
| Sotuv | ✅ | ✅ |
| Mahsulotlar | ✅ to'liq (narx, tahrir, o'chirish) | 👁 faqat ko'rish, tan narx ko'rinmaydi |
| Kirim, Firmalar, Hisobot, Kassa, Xodimlar | ✅ | ❌ ko'rinmaydi |

Chiqish uchun chap-pastdagi (yoki yuqoridagi) ismingiz ustiga bosing → **chiqish**.

> ⚠️ Parolni yozib qo'ying. Yagona administrator parolini unutsangiz, tiklab bo'lmaydi —
> brauzer ma'lumotini tozalab, boshqatdan boshlashga to'g'ri keladi.

---

## 1. Sotuv (eng ko'p ishlatiladigan amal)

1. **Sotuv**ni oching.
2. Qidiruvga mahsulot nomini yozing yoki shtrix-kodni skanerlang.
3. Ro'yxatdan mahsulotni **bosing** — savatga tushadi.
4. Sonini `−` / `+` bilan yoki qo'lda o'zgartiring. Bir nechta mahsulotni qo'shsangiz —
   hammasi bitta savatga yig'iladi.
5. **To'lov turini** tanlang: **Naqd · Plastik · Click** (odatda Naqd tanlangan turadi).
6. Pastda **Jami** va **Kutilayotgan foyda** ko'rinadi.
7. **"Sotuvni tasdiqlash"**.

Shu zahoti: qoldiq kamayadi, foyda hisoblanadi, yozuv tarixga tushadi. Agar **Naqd**
tanlangan bo'lsa — summa **Kassa**ga qo'shiladi (B qism, 7-bo'limga qarang).

> **Narx.** Sotish narxi avtomatik qo'yiladi. Chegirma qilsangiz — narx maydonini
> o'zgartiring, foyda o'zi qayta hisoblanadi.
>
> **Qoldiqdan ko'p sota olmaysiz.** Omborda 5 dona bo'lsa 6 dona sotib bo'lmaydi — tizim
> qizil bilan ogohlantiradi va tugmani bloklaydi.

---

## 2. Kirim (yangi tovar kelganda)

1. **Kirim**ni oching.
2. Mahsulotni toping va bosing, **nechta** kelganini va **kelish narxini** kiriting.
3. **Firma** tanlang (ixtiyoriy):
   - **Firmasiz** — oddiy kirim, faqat qoldiq oshadi.
   - **Firma tanlansa** — bu yetkazib berishga aylanadi: qoldiq ham oshadi, firmaga
     **qarz** ham yoziladi.
4. Firma tanlagan bo'lsangiz — **To'lov**ni tanlang:
   - **Qarzga** — summa firma qarziga qo'shiladi (keyin to'laysiz).
   - **Naqd / Plastik** — darhol to'lanadi, qarz qolmaydi (Naqd bo'lsa Kassadan chiqadi).
   - **Faktura №** va **kelgan sana**ni yozing.
5. **"Qabul qilish"** (yoki "Kirimni tasdiqlash").

Kelish narxini o'zgartirsangiz — mahsulotning tan narxi ham yangilanadi, keyingi
sotuvlarda foyda yangi narxdan hisoblanadi.

---

## 3. Mahsulotlar

- **"+ Mahsulot"** — yangi mahsulot qo'shish. Yangi brend qo'shish uchun brend maydoniga
  yangi nom yozing.
- **"📄 Excel import"** — Excel fayldan ko'plab mahsulot yuklash. Har varaq brend sifatida
  o'qiladi, ustunlar avtomatik aniqlanadi (kerak bo'lsa qo'lda to'g'rilang). Import faqat
  **qo'shadi**, borini o'chirmaydi; takror mahsulot yuklanmaydi.
- **"Tahrirlash"** — narx, nom, minimal zaxirani o'zgartirish yoki mahsulotni **o'chirish**.
- **Qoldiq raqamini bosish** — qoldiqni qo'lda tuzatish (sanab chiqdingiz / shikastlandi),
  **sabab** bilan.

Kassir bu bo'limda faqat nom, brend, sotish narxi va qoldiqni ko'radi — tan narx, foyda,
tahrir tugmalari unga ko'rinmaydi.

---

## 4. Firmalar (kimdan tovar olamiz)

Ro'yxatda har bir firma va unga **qarzimiz** ko'rinadi (qizil — qarz, yashil — avans).
To'lov muddati o'tsa **"kechikkan"** belgisi chiqadi.

**Firma ustiga bossangiz:**
- Yuqorida katta raqamda — **qarz** yoki **avans**.
- **Rekvizitlar:** STIR, hisob raqam, bank, MFO, direktor, telefon — pul o'tkazish uchun.
- **Hisob-kitob** (akt-sverka): har bir yetkazib berish va to'lov sana bo'yicha, o'ng
  tomonda yuguruvchi qoldiq bilan. Firma bilan hisoblashishda shu ro'yxatni ishlatasiz.
- **"To'lov qilish"** — firmaga to'lov yozish (summa, tur, sana, hujjat №). Qarz kamayadi.
- **"O'chirish"** — firmani o'chirish (tarix saqlanadi).
- Har bir yozuv yonidagi **"Bekor"** — noto'g'ri yetkazib berish yoki to'lovni bekor qiladi.

**Buyurtmalar** (yuqoridagi tugma): firmaga buyurtma berish. Buyurtma — bu **niyat**,
qoldiq ham qarz ham o'zgarmaydi. Holati o'zi aniqlanadi: **Kutilmoqda / Qisman keldi /
Keldi / Kechikkan**. Tovar kelganda **"Qabul qilish"**ni bossangiz — Kirim bo'limi shu
firma va qolgan mahsulotlar bilan to'ldirilib ochiladi. Buyurtmani **tahrirlash** yoki
**o'chirish** ham mumkin.

---

## 5. Xodimlar (faqat administrator)

- **"+ Xodim"** — yangi hisob (ism, rol, parol).
- **"Parolni almashtirish"** — xodim parolini yangilash.
- **"O'chirish"** — hisobni o'chirish. Oxirgi administratorni o'chirib bo'lmaydi.

---

## 6. Hisobot

Davrni tanlang (yoki `Dan`/`Gacha` sanalari), brend bo'yicha filtrlang, kunlik/haftalik/
oylik guruhlang.

- **To'lov turi bo'yicha tushum** — Naqd / Plastik / Click alohida ko'rsatiladi.
- **Amallar tarixi** — hamma sotuv va kirim. Noto'g'ri yozuvni **"Bekor qilish"** orqali
  tuzatasiz (yozuv o'chmaydi, teskari yozuv qo'shiladi, qoldiq tiklanadi).
- **"⬇ Excel'ga eksport"** — hisobotni Excel'ga yuklaydi.
- **☁️ Sinxronlash** — bulut hisobiga ulanish (7-bo'lim).
- **💾 Zaxira nusxa / ♻️ Tiklash** — Excel/JSON zaxira olish va tiklash.
- **🔴 Ma'lumotni tozalash** — bu qurilmadagi hamma savdo ma'lumotini o'chiradi (xodim
  hisoblari qoladi). Tasdiqlash uchun **"TOZALASH"** deb yozasiz. Ortga qaytmaydi.

---

## 7. Kassa (naqd pul hisobi — faqat administrator)

**"Kassada bo'lishi kerak"** — hozir yashikda qancha naqd pul bo'lishi kerakligini
ko'rsatadi. U o'zi hisoblanadi:

> **Kassa = Naqd sotuvlar − Firmalarga naqd to'lovlar + qo'lda kirim − qo'lda chiqim**

- **"+ Kirim"** — kassaga naqd qo'shish (boshlang'ich qoldiq, mayda pul).
- **"− Chiqim"** — kassadan naqd chiqishi: **Xarajat** (choy-non va h.k.) yoki
  **Yechib olindi** (bankka, egaga), **sabab** bilan.
- **"Sanash"** — yashikni sanab, haqiqiy summani kiriting. Farq bo'lsa tizim uni ko'rsatadi
  va bir tugma bilan **tuzatish** yozadi — Kassa haqiqatga tenglashadi.

> ⚠️ Kassa soni faqat siz **chiqimlarni yozib borsangiz** to'g'ri bo'ladi. Bankka pul
> olib borsangiz yoki yashikdan pul olsangiz — uni **Chiqim** sifatida yozing. Aks holda
> Kassa haqiqatdan ko'p ko'rsatadi; "Sanash" shu farqni ushlaydi.

---

## 8. Sinxronlash (bulut — barcha qurilmalar bitta ma'lumotni ko'rishi)

Ma'lumot avval **shu qurilmada** saqlanadi (internet yo'q bo'lsa ham ishlaydi), keyin
**Supabase** bulutiga yuboriladi. Shu tufayli telefon va kompyuter bitta ma'lumotni
ko'radi.

Ulash: **Hisobot → ☁️ Sinxronlash → do'kon hisobiga kiring** (bitta email + parol,
hamma qurilmada **bir xil**). Birinchi bo'lib **ma'lumoti bor** qurilmani ulang — u
bulutga yuboradi; keyin qolganlarini ulang.

> Xodim hisoblari (parollar) **bulutga yuborilmaydi** — ular faqat shu qurilmada qoladi.
> Ya'ni har qurilmada xodimlarni alohida qo'shasiz.

---

# B QISM — TIZIM MANTIG'I (AUDIT)

Bu qism tizim raqamlarni qanday chiqarishini va nega ularga ishonsa bo'lishini tushuntiradi.
Bitta tamoyil hammasini bog'lab turadi: **muhim raqamlar saqlanmaydi — ular yozuvlardan
hisoblab chiqariladi.**

### 1. Qoldiq saqlanmaydi — u hisoblanadi

Mahsulotning qoldig'i alohida raqam sifatida saqlanmaydi. Har bir kirim va sotuv — bu
**o'chmaydigan yozuv** (ledger). Qoldiq — shu yozuvlarning yig'indisi:

> qoldiq = Σ(kirimlar) − Σ(sotuvlar)

Nega shunday? Agar qoldiq oddiy raqam bo'lganda, ikki qurilma bir vaqtda sotsa, biri
ikkinchisining o'zgarishini "yutib" yuborardi (10 ni ikkalasi o'qiydi, ikkalasi 3 tadan
sotadi, natijada 6 ta ketadi lekin qoldiq faqat 3 taga kamayadi). Yig'indida bunday xato
bo'lmaydi — ikki qurilmaning yozuvlari uchrashganda o'zi to'g'ri qo'shiladi.

### 2. Firmaga qarz ham xuddi shunday hisoblanadi

> qarz = Σ(yetkazib berishlar) − Σ(to'lovlar)

Musbat — biz qarzdormiz; manfiy — biz avans berganmiz (firma bizga tovar qarz). "Avans"
alohida tushuncha emas — u shunchaki manfiy qarz. **Bitta yetkazib berish qabul qilinganda
qoldiq ham, qarz ham bitta yozuvda ko'tariladi** — shuning uchun ular hech qachon bir-biridan
ajralib qolmaydi.

### 3. Kassa ham hisoblanadi

> Kassa = Naqd sotuvlar − Firmalarga naqd to'lovlar + qo'lda kirim/chiqim

Hech qanday saqlangan "balans" yo'q — demak ikki qurilma uni buzolmaydi. Faqat **Naqd**
sotuv Kassaga ta'sir qiladi; Plastik va Click bankka/hisobga ketadi, yashikka tegmaydi.

### 4. Yozuvlar o'chmaydi — xato "teskari yozuv" bilan tuzatiladi

Sotuv, to'lov, yetkazib berish, kassa harakati — hech biri o'chirilmaydi va tahrirlanmaydi.
Xato bo'lsa: asl yozuv **"bekor qilingan"** deb belgilanadi va uning yoniga **teskari
(qarama-qarshi ishorali) yozuv** qo'shiladi. Ikkalasi qo'shilganda nolga teng bo'ladi.
Tarixda ikkalasi ham ko'rinib turadi — kim, qachon, nimani bekor qilgani yozib qoladi.
Shuning uchun hisobotlar hech qachon "ikki marta ayirib" xato qilmaydi.

### 5. O'chirish — "tombstone" (belgi), butunlay yo'q qilish emas

Mahsulot, firma yoki buyurtma "o'chirilganda" u bazadan yo'q qilinmaydi — "o'chirilgan"
deb **belgilanadi**. Buning sababi sinxronlash: agar yozuv shunchaki yo'qolsa, ikkinchi
qurilma uni "yangi qo'shilgan, hali kelmagan" yozuvdan ajrata olmaydi va noto'g'ri qaror
qabul qiladi. Belgi esa barcha qurilmalarga to'g'ri tarqaladi.

### 6. Ikki sana qoidasi (sinxronlash uchun muhim)

Yetkazib berish, to'lov va kassa harakatida **ikki sana** bor: yozuv **yozilgan vaqt**
(o'zgarmas) va **haqiqiy sana** (siz kiritasiz, orqaga surish mumkin). Sinxronlash doim
**yozilgan vaqt** bo'yicha ishlaydi. Aks holda kechagi yetkazib berishni bugun kiritsangiz,
u boshqa qurilmaga hech qachon yetib bormasdi. Hisob-kitob va kechikish esa **haqiqiy sana**
bo'yicha hisoblanadi.

### 7. Oflayn va ko'p qurilma xavfsizligi

Har bir amal avval shu qurilmaning ichki bazasiga (IndexedDB) yoziladi — internet shart
emas. Bulut (Supabase) — uchrashuv nuqtasi: har qurilma o'zi yozganini yuboradi, boshqalar
yozganini oladi. Yozuvlar **o'chmas va noyob raqamli** bo'lgani uchun ikki qurilma bir
vaqtda ishlasa ham bir-birini buzmaydi. Yagona holat: ikki qurilma **ikkalasi ham oflayn**
oxirgi donani sotsa — ular ulanganda qoldiq manfiy chiqadi va tizim buni yashirmasdan
ko'rsatadi (qayta sanash kerak).

### 8. Rollar — bu qulaylik chegarasi, harbiy himoya emas

Kirish va rollar (admin/kassir) ishlab turadi: kassir faqat sotadi va mahsulotni ko'radi,
qolgan bo'limlar unga ko'rinmaydi va URL orqali ham kira olmaydi. Parollar ochiq matnda
saqlanmaydi — ular **PBKDF2** bilan shifrlanadi (qaytarib ochib bo'lmaydigan "hash").

Ammo halol bo'laylik: bu **ishonchli qurilmadagi qulaylik chegarasi**, server darajasidagi
himoya emas. Brauzer "developer tools"ini biladigan odam uni chetlab o'tishi mumkin. Do'kon
kassasi uchun bu yetarli daraja. Shu sababli xodim parollari zaxira faylga **hech qachon**
qo'shilmaydi — zaxirani ulashsangiz ham parollar chiqib ketmaydi.

### 9. Foyda va tan narx — o'zgarmas "surat"

Foyda hech qachon qo'lda kiritilmaydi: u har sotuvda `(sotish − tan narx) × soni` bo'lib
hisoblanadi. Tan narx **sotuv vaqtida** yozib qo'yiladi ("snapshot"). Shuning uchun keyin
narxni o'zgartirsangiz, eski sotuvlarning foydasi o'zgarmaydi — tarix o'zgarmas qoladi.

---

## Muhim qoidalar (qisqacha)

- **Foyda va qoldiqni qo'lda yozmaysiz** — tizim o'zi hisoblaydi.
- **Yozuvlar o'chmaydi** — xato bekor qilinadi, lekin tarixda qoladi.
- **Internet shart emas** — tizim oflayn ishlaydi; ulanganda bulut bilan sinxronlanadi.
- **Bulutga ulanish** uchun hamma qurilma **bir xil do'kon hisobiga** kirishi kerak.
- **Zaxira nusxani unutmang** — haftada bir marta (Hisobot → Zaxira nusxa).
- **Kassa to'g'ri bo'lishi uchun** har bir naqd chiqimni yozib boring.
