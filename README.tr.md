# YouTube Music Studio

[English](README.md) · **Türkçe**

YouTube Music Studio, `music.youtube.com`'u steampunk görünümlü bir masaüstü uygulamasına çeviren ve üstüne bir **ses stüdyosu** ekleyen bir Windows programıdır. Şarkıyı kayıpsız hâliyle dinlemenin yanında:

- şarkıyı **vokal / davul / bas / diğer** olarak ayırıp ayrı ayrı kısabilir, kapatabilir ya da yalnız dinleyebilirsiniz,
- **karaoke** yapıp mikrofonunuzu profesyonel bir **vokal zincirinden** geçirebilir ve kaydedebilirsiniz,
- şarkının **tonunu (Key)** ve **hızını (Tempo)** değiştirebilirsiniz,
- **ekolayzır, enhancer, limiter** ile sesi şekillendirebilirsiniz,
- **senkron şarkı sözlerini** izleyebilir, bir satıra tıklayarak şarkıyı oraya sardırabilirsiniz,
- kayıtlarınızı katmanlı olarak saklayıp **karıştırıp MP3 olarak dışa aktarabilirsiniz.**

Hesabınız normal YouTube Music hesabınızdır; giriş yaptığınızda kitaplığınız, listeleriniz ve önerileriniz olduğu gibi gelir. Ses işleme **tamamen kendi bilgisayarınızda** yapılır (yapay zekâ modelleri uygulamayla birlikte gelir, internete ses gönderilmez).

> Bu proje YouTube veya Google ile bağlantılı değildir. Yalnızca kendi hesabınızla, kişisel kullanım için tasarlanmıştır.

---

## İçindekiler

1. [Kurulum](#1-kurulum)
2. [Güncellemeler](#2-güncellemeler)
3. [Ekranı tanıyın](#3-ekranı-tanıyın)
4. [Stüdyo çekmecesi](#4-stüdyo-çekmecesi)
5. [Modlar: Listen, Listen with Stems, Karaoke](#5-modlar)
6. [Stem ayırma (vokal, davul, bas, diğer)](#6-stem-ayırma)
7. [Karaoke adım adım](#7-karaoke-adım-adım)
8. [Vokal zinciri (Vocal Chain)](#8-vokal-zinciri)
9. [Key & Tempo](#9-key--tempo)
10. [Ekolayzır](#10-ekolayzır)
11. [Enhancer](#11-enhancer)
12. [Output: master, limiter ve VU göstergeleri](#12-output)
13. [Kayıtlar, Mixer ve dışa aktarma](#13-kayıtlar-mixer-ve-dışa-aktarma)
14. [Şarkı sözleri](#14-şarkı-sözleri)
15. [Video modu: steampunk televizyon](#15-video-modu-steampunk-televizyon)
16. [Steampunk görünümü](#16-steampunk-görünümü)
17. [Gizlilik](#17-gizlilik)
18. [Sorun giderme](#18-sorun-giderme)
19. [Kaynaktan çalıştırma ve geliştirme](#19-kaynaktan-çalıştırma-ve-geliştirme)
20. [Yeni sürüm yayınlama](#20-yeni-sürüm-yayınlama)

---

## 1. Kurulum

**Gereksinimler:** Windows 10/11 (64 bit), yaklaşık 700 MB boş disk alanı, 8 GB RAM (stem ayırma için 16 GB önerilir). Karaoke için bir mikrofon ve **kulaklık** (bkz. [Karaoke](#7-karaoke-adım-adım)).

1. `YouTube-Music-Studio-Setup-<sürüm>.exe` dosyasını [Releases](../../releases) sayfasından indirin.
2. Çalıştırın. Kurulum yolunu seçebilirsiniz; masaüstü ve Başlat menüsü kısayolu oluşturulur.
3. İlk açılışta Windows "Bilinmeyen yayıncı" uyarısı çıkarsa **Ek bilgi → Yine de çalıştır** deyin. (Uygulama henüz dijital olarak imzalanmamıştır.)
4. Sağ üstteki **Sign in** düğmesiyle Google hesabınıza giriş yapın. Oturum bir sonraki açılışa kadar saklanır.

Yapay zekâ modelleri (`htdemucs`, `umx-hq`) kurulumun içindedir; ayrıca indirmeniz gerekmez.

Kaldırmak için Windows **Ayarlar → Uygulamalar** kullanın. Kayıtlarınız ve oturumunuz `%APPDATA%\YTM-Audio-POC` klasöründe kalır; kaldırma bunları silmez.

## 2. Güncellemeler

Uygulama açıldıktan kısa süre sonra (ve sonrasında her 4 saatte bir) GitHub'daki **yayınlara (Releases)** bakar. Daha yeni bir sürüm varsa şöyle bir pencere çıkar:

> *A new version of YouTube Music Studio is available (1.2.0). Download now / Later*

- **Download now**: sürüm arka planda indirilir, pencerenin görev çubuğu simgesinde ilerleme görünür. Bitince "Restart and install" (hemen yeniden başlat ve kur) ya da "Install when I close the app" (uygulamayı kapattığınızda kur) seçeneğini sunar.
- **Later**: hiçbir şey indirilmez; bir sonraki kontrolde yine sorulur.

Bilgisayar internete bağlı değilse veya GitHub'a ulaşılamazsa kontrol sessizce atlanır, hata göstermez. Bir sürümün "yayınlanmış" sayılması için GitHub'da bir Release oluşturulması gerekir; yalnızca depoya kod göndermek (commit) kullanıcılara güncelleme olarak ulaşmaz. Ayrıntı için [20. bölüm](#20-yeni-sürüm-yayınlama).

## 3. Ekranı tanıyın

Uygulama normal YouTube Music'tir; üzerine şunlar eklenmiştir:

| Bölge | Ne var |
|---|---|
| **Üst bar** | Logo plakası, arama kutusu, canlı **analog VU göstergeleri (L/R)**, pirinç **VOLUME** düğmesi, cast, hesap resmi ve **Sign in**. Pencere dar olduğunda VU'lar gizlenir, yalnızca ses düğmesi kalır. İsterseniz üstteki **grafik ekolayzır** şeridi de buraya açılır. |
| **Sol panel** | Home / Explore / Library menüsü ve çalma listeleriniz. Kenarda **RECORDINGS** sekmesi (kayıtlarınız). |
| **Orta alan** | Ana sayfa rafları, albüm ve çalma listesi sayfaları. Her şarkı listesi pas dokulu bir levhanın içindedir. |
| **Sağ kenar** | **LYRICS** sekmesi (şarkı sözleri paneli). |
| **Alt oynatıcı çubuğu** | Şarkı adı, sanatçı, **canlı spektrum dalga formu** ile ilerleme çubuğu, oynat/duraklat/ileri/geri/karıştır/tekrarla düğmeleri. İlerleme çizgisinin üzerine tıklayarak şarkıda gezinebilirsiniz. |
| **STUDIO sekmesi** | Alt çubuğun hemen üstünde, ortada. Tıklayınca **Stüdyo çekmecesi** açılır. |

## 4. Stüdyo çekmecesi

Alttaki **STUDIO ▲** sekmesine tıklayın. Ekranın altından, referans steampunk deri zeminli, tam genişlikte bir çekmece çıkar. Üst sıra soldan sağa:

**SESSION · KEY & TEMPO · MIXER · EQUALIZER · ENHANCER · OUTPUT**

Alt sırada **VOCAL CHAIN** modülleri, en altta bir **durum şeridi** (ayırma modeli, yakalama durumu, "underruns" sayacı) vardır. Çekmece kapatıldığında Studio ayarları (EQ, Enhancer, Key, Output) çalışmaya devam eder; yalnızca ekrandan kalkar.

Çekmecenin sağ tarafındaki vana, boru çarkları, kondansatör lambaları ve buhar süs değildir: **vokal zinciri gerçekten kullanımdayken** (mikrofon açık, karaoke ya da mixer görünümü) hareket eder. Böylece bir bakışta zincirin çalıştığını anlarsınız.

## 5. Modlar

**SESSION** bölümünde üç düğme vardır. Biri yanık olur, diğerine basmak onu bırakır.

| Mod | Ne yapar |
|---|---|
| **LISTEN** | Normal YouTube Music. Hiçbir ses işleme yoktur (yalnızca isterseniz EQ/Enhancer çalışır). Program bu modda açılır. |
| **LISTEN WITH STEMS** | Şarkıyı yakalar, yapay zekâyla stem'lere ayırır ve mikserden çalar. Vokali kısabilir, davulu kapatabilirsiniz. Başlarken ekranın ortasında **"BUFFERING, PLEASE WAIT n"** geri sayımı görürsünüz (bkz. [Stem ayırma](#6-stem-ayırma)). Tekrar basınca normal dinlemeye dönersiniz. |
| **KARAOKE** | Karaoke moduna geçer; müzik durur. **START KARAOKE** düğmesine basana kadar hiçbir şey kaydedilmez. Ayrıntı: [Karaoke](#7-karaoke-adım-adım). |

Her moddan her moda doğrudan geçebilirsiniz; geçiş sırasında yakalama ve vokal zinciri otomatik kapanır/açılır.

**ADVANCED** düğmesi, ayırma modelinin seçildiği dikey formu açar (örn. `htdemucs` kaliteli ama ağır, `umx-hq` hızlı ve hafiftir).

## 6. Stem ayırma

Stem'ler: **Vocals** (vokal), **Drums** (davul), **Bass** (bas), **Other** (diğer enstrümanlar). MIXER bölümünde **VOCALS** ve **INSTR.** (enstrümanlar) kanalları ile **KARAOKE MIC** kanalı bulunur; her birinde fader, **SOLO** ve **MUTE** vardır. Tam 5 kanallı karışımda (vokal, davul, bas, diğer, mikrofon) her stem'i ayrı yönetebilirsiniz.

**Neden "BUFFERING" geri sayımı?** Ayırma gerçek zamanlı çalışabilmek için şarkıdan **yaklaşık 10 saniyelik bir tampon** biriktirir. Bu yüzden ayrılmış ses, orijinalden birkaç saniye geriden gelir. Program bunu ölçer ve şu işleri bu gecikmeye göre yapar: şarkı sözleri, karaoke geri sayımı ve kayıtların hizalanması. Ekrandaki "BUFFER x.x s" değeri, o anki tampon uzunluğudur.

İpuçları:

- Davul/perküsyonda ton kaydırma (Key) hafif yapay ses (artefakt) verebilir. Bunun nedeni zaman uzatma/ton kaydırma algoritmasının doğasıdır.
- Çok yoğun mastering'li şarkılarda vokal kaçakları (hayalet vokal) normaldir; ayırma modelleri %100 mükemmel değildir.
- Ayırma işlemci kullanır. Durum şeridindeki **UNDERRUNS** sayacı artıyorsa bilgisayar yetişemiyordur; daha hafif model seçin veya diğer ağır uygulamaları kapatın.

## 7. Karaoke adım adım

1. **Kulaklık takın.** Mikrofonunuz hoparlörü duyarsa geri besleme (vıyyyk) olur ve kayıt bozulur. Zincirdeki **USE HEADPHONES** uyarısı bunun içindir.
2. **SESSION → KARAOKE** düğmesine basın. Müzik durur; ekranda *"PRESS START KARAOKE WHEN READY"* yazar. Aşağıdaki **Vocal Chain** bölümü görünür.
3. Şarkıyı YouTube Music'te seçin (karaokeye başlamadan şarkı çalmaya başlamış olmalı değildir; program şarkıyı **baştan** başlatır).
4. Vocal Chain'in **INPUT** bölümünden mikrofonunuzu seçin ve **LEVEL**'i ayarlayın. İsterseniz **AUTO-TUNE**'u ve diğer modülleri açın (bkz. [Vokal zinciri](#8-vokal-zinciri)). Bir **zincir ön ayarı** (örn. *Clean Pop*) seçmek en hızlı yoldur.
5. **START KARAOKE**'ye (veya zincirdeki **REC**'e) basın. Program:
   - şarkıyı başa sarar, vokal stem'ini susturur (müziği yalnızca enstrümanlar olarak duyarsınız),
   - mikrofonu ve vokal zincirini açar,
   - ekranın ortasında **"BUFFERING, PLEASE WAIT n"** geri sayımı gösterir (stem gecikmesi dolana kadar),
   - hazır olunca **kayıt başlar** ve şarkı sözleri akmaya başlar.
6. Söyleyin. Şarkı sözleri panelinde (sağ kenar) satırlar akar; bir satıra tıklarsanız şarkı oraya gider.
7. Bitirmek için tekrar **START KARAOKE / REC**'e basın: **STOP & SAVE**. Kayıt kaydedilir, mikrofon ve stem'ler kapanır, müzik durur. Mod karaoke olarak hazır kalır.

Kayıtlar **katmanlı** saklanır: vokal, davul, bas, diğer, mikrofon (işlenmiş), mikrofon (ham). Böylece sonradan her katmanı ayrı ayrı yeniden karıştırabilirsiniz ([Kayıtlar](#13-kayıtlar-mixer-ve-dışa-aktarma)).

**Kayıtsız deneme:** Listen modunda mikrofon kanalının altındaki pirinç **ACTIVATE MIC** anahtarı, mikrofonunuzu ve vokal zincirini kayıt yapmadan açar. Efektleri denemek ve prova için idealdir.

## 8. Vokal zinciri

Mikrofon sinyali soldan sağa şu modüllerden geçer. **Her modülün kendi açma/kapama LED'i** vardır; kapalı modül sese hiç girmez. Her modülün altında o modüle özel **ön ayar** menüsü, en üstte **tüm zincir ön ayarı** menüsü bulunur.

| Sıra | Modül | Ne işe yarar |
|---|---|---|
| 1 | **INPUT** | Mikrofon seçimi, giriş seviyesi (LEVEL), mono'ya toplama. Karaokede iki kulağa eşit gider. |
| 2 | **AUTO-TUNE** | Sesi seçtiğiniz **Key** ve **Scale** (örn. C / Major) notalarına çeker. **SPEED**: ne kadar hızlı düzeltileceği (düşük = doğal, yüksek = "robot" efekti). **AMOUNT**: düzeltme oranı. |
| 3 | **GATE** | Siz susarken mikrofona giren oda gürültüsünü keser. **THRESH** eşiği: bunun altındaki sesi kısar. |
| 4 | **LOW CUT** | Alçak frekansları (nefes patlamaları, masa gürültüsü) keser. **FREQ** ile kesme noktası seçilir. |
| 5 | **EQ** | Vokale özel alçak raf (LOW) ve "çamur" (MUD) bölgesi ayarı: sesi inceltir ya da doldurur. |
| 6 | **COMP** | Kompresör: yüksek ve alçak sesler arasındaki farkı daraltır; vokal öne çıkar. **AMOUNT** sıkıştırma miktarı. Gain reduction (GR) çubuğu ne kadar bastırıldığını gösterir. |
| 7 | **DE-ESS** | "S" ve "Ş" seslerinin cızırtısını yumuşatır. GR çubuğu vardır. |
| 8 | **PRESENCE** | Ses netliği/parlaklığı (**AIR**) ekler. |
| 9 | **SATURATION** | Hafif tüp/bant doygunluğu (**DRIVE**) ve ham sesle karışımı (**MIX**). Sese sıcaklık katar. |
| 10 | **DOUBLER** | Sesi kısa gecikmeli ve hafif modüleli bir kopyayla ikiler; "iki vokal" kalınlığı ve yayılma (**AMOUNT / WIDTH**). |
| 11 | **HARMONIZER** | Sesinizin üstüne **armoni** ekler: oktav aşağı, üçlü (+3), dörtlü (+4), beşli (+5), oktav yukarı. **LEVEL** ile ne kadar duyulacağını belirlersiniz. |
| 12 | **REVERB** | Yankı/oda etkisi. **SEND** ne kadar gönderileceği, **DECAY** süresi. |
| 13 | **DELAY** | Eko. **SEND** ve **TIME**. |
| 14 | **OUTPUT** | **CHAIN ON** (tüm zincirin ana şalteri) ve **REC** (kayıt). |

**Tüm zincir ön ayarları:** *Flat (all neutral)*, *Clean Pop*, *Rock Edge*, *Hip-Hop*, *Ballad*, *Karaoke Fun*, *Radio / Lo-fi*, *Stadium*, *Harmony Stack*, *Podcast*. Birini seçince zincir otomatik açılır; sonra tek tek modüllerle oynayabilirsiniz.

**İpuçları**

- Önce bir ön ayar seçin, sonra yalnız GATE ve LEVEL'i ayarlayın; çoğu zaman yeter.
- Auto-Tune'da şarkının tonunu bilmiyorsanız SPEED'i düşük tutun (daha az müdahale eder).
- Harmonizer ve Doubler yanlış notalarda belirgin duyulur; azar azar ekleyin.
- Zincirin mikrofon üzerindeki etkisi, **kayıttan sonra Mixer'da da** uygulanır; kayıt sırasındaki ayarla yetinmeyip sonradan değiştirebilirsiniz.

## 9. Key & Tempo

**KEY & TEMPO** bölümü hem normal dinlemede hem stem modunda çalışır.

- **KEY** (−8 … +8 yarım ton): şarkının tonunu değiştirir. Sesin tizliği/pesliği değişir, hızı değişmez. Karaokede şarkıyı sesinize göre indirip çıkarmak için kullanılır. Stem modunda ton, stem katmanlarına ve **kayıtlara** da uygulanır; yani kaydınız şarkılan tonda saklanır.
- **TEMPO** (%50 … %150): şarkının hızını değiştirir, **tonu bozmadan** (tarayıcı zaman uzatma). Şarkı sözleri ve kayıt hızı bu değere uyar.
- **RESET**: ikisini de başlangıç değerine (0 / %100) döndürür.

Ton değişimi yüksek kaliteli **Signalsmith Stretch** algoritmasıyla yapılır. Bir sapma ya da yapay ses duyarsanız KEY'i 0'a alıp tekrar deneyin.

## 10. Ekolayzır

İki mod vardır; **aynı anda yalnız biri** seçilebilir:

- **PARAMETRIC**: 6 numaralı noktaya tıklayıp sürükleyerek bant tipi (bell vb.), frekans, kazanç ve Q ayarlarsınız. Grafikte canlı spektrum görünür.
- **GRAPHIC EQ**: 10 bantlı klasik fader EQ (32 Hz – 16 kHz). Çekmecedeki faderlar, üst bardaki grafik ekolayzırla aynıdır.

Her ikisinde de **EQ ON / OFF** anahtarı, **ön ayar** menüsü ve **SAVE / DEL** ile kendi ön ayarlarınızı kaydetme vardır (isim kutusuna yazıp SAVE'e basın). Üst bardaki grafik EQ şeridinde ayrıca *Loudness* gibi hazır ayarlar bulunur.

## 11. Enhancer

Sese renk ve genişlik katar. **ENHANCER** anahtarı ile açılır. Dört kontrol:

- **DRIVE**: harmonik zenginlik.
- **WARMTH**: alçak-orta sıcaklık.
- **AIR**: yüksek frekans parlaklığı.
- **WIDTH**: stereo genişliği.

Altta **ANALOG**, **VINYL**, **TAPE** karakter düğmeleri vardır. Enhancer açıkken çekmecedeki üç çark da dönmeye başlar.

## 12. Output

**OUTPUT** bölümü ana çıkıştır:

- **VU (L/R)**: sol ve sağ kanalın analog gösterge ibreleri.
- **MASTER**: ana ses seviyesi düğmesi.
- **THRESH + LIMITER**: çıkış kırpılmasın (cızırtı olmasın) diye bir **limiter**. THRESH, limiter'in devreye girdiği seviyedir; LIMITER düğmesi ile açılır, kapalıyken THRESH solar.

Ses bozulursa önce MASTER'ı ve Enhancer DRIVE'ı kısın, sonra LIMITER'ı açın.

## 13. Kayıtlar, Mixer ve dışa aktarma

Sol kenardaki **RECORDINGS** sekmesi, bu uygulamayla yaptığınız karaoke kayıtlarını listeler. Bir kaydı seçip çalabilirsiniz. Kayıt yüklüyken çekmece **Mixer görünümüne** döner:

- **LAYERS** sekmesi: vokal, davul, bas, diğer, mikrofon (işlenmiş) ve mikrofon (ham) katmanlarını ayrı fader / SOLO / MUTE ile karıştırırsınız.
- **MIXED** sekmesi: tek parça hazır karışım.
- **Vokal zinciri burada da çalışır**: ham mikrofon kaydına (micdry) zinciri **sonradan** uygulayıp ayarlayabilirsiniz. Böylece kayıttan sonra Auto-Tune, reverb, kompresör gibi şeyleri değiştirebilirsiniz.
- **MIC SHIFT**: mikrofonun müzikle hizasını ince ayarlar. Stem gecikmesi nedeniyle hafif geride/ileride kalan vokali burada hizalarsınız.
- **EXPORT**: karışımı (zincir dahil) çevrimdışı işleyip **MP3** olarak diske kaydeder. Dosya adı ve yeri bir kayıt penceresiyle sorulur.

Kayıtlar `%APPDATA%\YTM-Audio-POC\recordings` klasörüne, her biri bir `.layers` alt klasörüyle (katmanlar WAV olarak) kaydedilir. Yedeklemek için bu klasörü kopyalayabilirsiniz.

## 14. Şarkı sözleri

Sağ kenardaki **LYRICS** sekmesine tıklayın (karaokeye girince otomatik açılır; YouTube Music'in kendi *LYRICS* sekmesinden ayrıdır). Panelde sanatçı, albüm ve şarkı adı en üstte, sözler altta görünür.

- **Senkron sözler** (zaman damgalı) varsa çalan satır vurgulanır ve akar.
- **Bir satıra tıklayın**: şarkı oraya gider ve o satır yanık kalır.
- **SYNC −/+ 0,5 sn**: sözler ses ile uyuşmuyorsa elle ileri/geri kaydırırsınız.
- Sözler **şarkının gerçek sesine** göre hizalanır: stem gecikmesi ve TEMPO ayarı hesaba katılır.

Sözler şu kaynaklardan sırayla aranır, ilk bulan kullanılır: **LRCLIB → NetEase → Kugou → lyrics.ovh**. İlki en güvenilirdir ve resmîdir; diğerleri resmî olmayan uç noktalardır ve zaman zaman çalışmayabilir. Bazı şarkılar için senkron söz bulunamaz; o durumda düz metin gösterilebilir veya hiç söz çıkmayabilir.

## 15. Video modu: steampunk televizyon

Oynatıcı sayfasında (bir şarkı çalarken kapak resmine tıklayınca) video veya albüm kapağı, **steampunk bir televizyonun** camında görünür:

- Üstteki küçük plakada çalan **şarkı adı ve sanatçı** amber renkli dijital yazıyla sağdan sola sürekli kayar (hafif tarama çizgileri ve kısa flicker ile).
- Televizyonun iki yanındaki **tüp lambalar** parlar ve hafifçe titrer.
- Altındaki **SONG** ve **VIDEO** pirinç düğmeleriyle şarkı ile video arasında geçersiniz; seçili olan amber yanar.
- Pencere boyutuna göre televizyon otomatik küçülür, hep sığar. Video 16:9 değilse (4:3, kare kapak) camın iki yanı siyah kalır.
- Sağdaki **Up Next** paneli de pas dokulu levha içindedir.

## 16. Steampunk görünümü

Görsel tema tamamen bu uygulamaya aittir ve YouTube Music üzerine çizilir:

- **Dokular:** paslı deri, pirinç, perçinli levhalar, zincirler ve dişliler. Sayfa kenarlarında kaydırdıkça hareket eden iki zincir ve köşelerde dönen dişliler vardır.
- **Canlı arka plan:** titreyen lambalar, dönen kırmızı vana, ibreli gösterge ve buhar (arka planı ağırlaştırmamak için hafif tutulmuştur).
- **Raf başlıkları:** filaman telli plaka üzerinde neon yazı; yazılar kısa bir "kıvılcım" animasyonuyla belirir, kablolar elektrik akıtır.
- **Şarkı listeleri:** her liste, pas dokulu bir levha ve iki kelepçeyle zincire bağlıdır (albüm ve çalma listesi sayfaları dahil). Albüm ve çalma listesi sayfalarında kapak/ad/butonlar sol bölmede **sabit** durur, kaydırınca takılmaz.
- **Üst bar:** logo "neon plaka"sı, pirinç oval arama kutusu, canlı VU göstergeleri, pirinç VOLUME düğmesi.
- **Oynatıcı çubuğu:** koyu zemin, **canlı spektrum** ile ilerleme çizgisi, pirinç transport düğmeleri.
- **Stüdyo çekmecesi:** deri zemin, pirinç düğmeler, analog VU'lar, dönen çarklar (Session/Key&Tempo/Enhancer/yan sütun), kablolar, kondansatör lambaları ve buhar. Çarkların dönüş yönü ve hızı, seçtiğiniz moda ve KEY/TEMPO adımına bağlıdır.
- **Yazı tipleri:** Oswald, Barlow, Cinzel Decorative, Nixie One, VT323 (hepsi SIL Open Font License; bkz. `design/fonts/LICENSES.md`).

Görsel efektler işlemci kullanır; bilgisayarınız zorlanıyorsa pencereyi küçültmek ya da ayırma modelini hafifletmek işe yarar.

## 17. Gizlilik

- **Ses bilgisayarınızdan çıkmaz.** Stem ayırma, vokal zinciri, kayıt ve dışa aktarma tamamen yereldir.
- **Şarkı sözü araması** dışarı yalnızca **sanatçı, şarkı adı, albüm ve süre** bilgisini yollar (LRCLIB, NetEase, Kugou, lyrics.ovh).
- **Giriş bilgileriniz** YouTube Music'e (Google) yöneliktir; uygulama şifrenizi görmez veya saklamaz, oturum çerezleri `%APPDATA%\YTM-Audio-POC` içindeki Chromium profilinde tutulur.
- **Güncelleme kontrolü** yalnızca GitHub'dan sürüm bilgisini ister.
- Hata ayıklama günlükleri `%APPDATA%\YTM-Audio-POC\logs` içindedir ve ses içeriği taşımaz.

## 18. Sorun giderme

| Sorun | Çözüm |
|---|---|
| Karaokede kendi sesim yankı yapıyor / vıyıltı | Kulaklık takın. Hoparlörle karaoke yapılamaz. |
| "BUFFERING" çok uzun sürüyor / UNDERRUNS artıyor | Ayırma modelini hafifletin (ADVANCED), arka plandaki ağır uygulamaları kapatın. |
| Sözler ses ile uyuşmuyor | LYRICS panelinde SYNC ile ±0,5 sn adımlarla kaydırın. |
| Mikrofon görünmüyor | Windows **Gizlilik → Mikrofon** izninin açık olduğunu ve doğru cihazın INPUT'ta seçildiğini kontrol edin. |
| Ses kırpılıyor/bozuluyor | MASTER'ı kısın, LIMITER'ı açın, Enhancer DRIVE'ını azaltın. |
| Giriş yapamıyorum | YouTube Music'i bir tarayıcıda açıp hesabınızın çalıştığını doğrulayın; uygulamayı kapatıp yeniden açın. |
| Güncelleme çıkmıyor | Yeni sürüm GitHub'da **Release** olarak yayınlanmalıdır; yalnızca commit güncelleme sayılmaz. |
| Görüntü takılıyor | Pencereyi küçültün, STUDIO çekmecesini kapatın, başka ağır uygulamaları kapatın. |

Hâlâ çözemezseniz [Issues](../../issues) sayfasına, `%APPDATA%\YTM-Audio-POC\logs` içindeki son günlük dosyasını ekleyerek yazın.

## 19. Kaynaktan çalıştırma ve geliştirme

Gereksinimler: **Node.js 24+**, Git, Windows.

```bash
git clone https://github.com/dhurakisra/YouTube-Music-Studio.git
cd YouTube-Music-Studio
npm install
# yapay zekâ modellerini models/ klasörüne koyun:
#   models/htdemucs_fp16.onnx
#   models/umx-hq-vocals.onnx
npm start          # uygulamayı aç
npm run smoke      # açılış testi (oturum/ses denemez)
```

Önemli dosyalar:

| Yol | İçerik |
|---|---|
| `src/main.js` | Ana süreç: pencere, IPC, kayıt, MP3 kodlama, güncelleme kurulumu |
| `src/preload.js` | YouTube Music sayfasına enjekte edilen her şey: steampunk tema, Stüdyo çekmecesi, ses motoru (vokal zinciri, EQ, Key/Tempo), şarkı sözü paneli, televizyon |
| `src/stem-process.js` | HT-Demucs/UMX ile stem ayırma (ayrı süreç) |
| `src/lyrics-sources.js` | Söz kaynakları |
| `src/updater.js` | GitHub sürüm kontrolü |
| `design/tex`, `design/fonts` | Görsel dokular ve yazı tipleri (çalışma zamanında kullanılır) |
| `design/tools/*.py` | Görsel asset kesme/üretme betikleri (Python + Pillow) |
| `PLAN.md`, `CONTRACT.md` | Geliştirme notları ve sözleşmeler |

Önemli geliştirme notları: `preload.js` sandbox'lıdır (kod `require` ile yerel dosya yükleyemez); YouTube Music `innerHTML`'i engeller (Trusted Types), bu yüzden `h()` yardımcısıyla DOM kurulur.

## 20. Yeni sürüm yayınlama

Kurulum dosyası **electron-builder** ile üretilir; güncelleme **GitHub Releases** üzerinden dağıtılır. Kullanıcıların uygulaması yeni bir sürüm olduğunu ancak **Release yayınlanınca** görür.

```bash
# 1) package.json içindeki "version" alanını artırın (örn. 1.0.0 -> 1.1.0)
# 2) build.publish içinde owner ve repo'yu kendi GitHub depo bilgilerinizle doldurun (bir kez)
# 3) Yerelde kurulum dosyası üretmek (yayınlamadan):
npm run dist                 # dist/YouTube-Music-Studio-Setup-<sürüm>.exe

# 4) GitHub Release'e yüklemek (GH_TOKEN ortam değişkeni gerekir: "repo" yetkili kişisel erişim anahtarı):
set GH_TOKEN=ghp_...         # PowerShell: $env:GH_TOKEN="ghp_..."
npm run dist:publish
```

`dist:publish`, kurulum dosyasını ve güncelleme bilgi dosyalarını (`latest.yml`, `.blockmap`) bir GitHub Release'e yükler. Uygulamalar bu dosyaya bakarak yeni sürümü algılar. Yapay zekâ modelleri (≈ 180 MB) kurulumun içine gömülüdür, bu yüzden kurulum dosyası yaklaşık 325 MB'dır ve Git depolarında tutulmaz (`models/` `.gitignore`'dadır).

> Not: Kurulum dosyası şu an **imzasızdır**; Windows SmartScreen uyarı verebilir. İmza için bir kod imzalama sertifikası gerekir.

---

*Lisans ve teşekkürler:* yazı tipleri SIL OFL 1.1 ile; ton kaydırma [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) (MIT); stem ayırma modelleri HT-Demucs ve Open-Unmix.
