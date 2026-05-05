https://developer.nvidia.com/cuda-12-4-0-download-archive?target\_os=Windows\&target\_arch=x86\_64\&target\_version=11\&target\_type=exe\_local



https://my.visualstudio.com/Downloads?q=visual%20studio%202022\&wt.mc\_id=o\~msft\~vscom\~older-downloads



\# Установи Rust (если нет)

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh



git clone https://github.com/TrevorS/qwen3-tts-rs.git

cd qwen3-tts-rs



\# Собери с поддержкой CUDA (или убери cuda для CPU / metal для Mac)

cargo build --release --features cli,cuda



install hugging face cli

powershell -ExecutionPolicy ByPass -c "irm https://hf.co/cli/install.ps1 | iex"



\# Пример для 0.6B CustomVoice (самый быстрый + preset-спикеры)

hf download Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice --local-dir models/customvoice-0.6b

hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --local-dir models/customvoice-1.7b



\# Или 1.7B Base (для voice cloning)

hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir models/base-1.7b



https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-design



When writing a voice description (voice\_prompt), follow these technical constraints:



Length limit: The voice\_prompt content must not exceed 2,048 characters.



Supported languages: Description text supports Chinese and English only.





Gender



Male, female, neutral



Age



Child (5–12), teenager (13–18), young adult (19–35), middle-aged (36–55), elderly (55+)



Pitch



High, medium, low, high-pitched, low-pitched



Pace



Fast, medium, slow, fast-paced, slow-paced



Emotion



Cheerful, calm, gentle, serious, lively, composed, soothing



Characteristics



Magnetic, crisp, hoarse, mellow, sweet, rich, powerful



Purpose



News broadcast, ad voice-over, audiobook, animation character, voice assistant, documentary narration





\# VoiceDesign (если хочешь описывать голос текстом)

hf download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign --local-dir models/voicedesign-1.7b



\# Обычный TTS с preset-спикером (CustomVoice)

./generate\_audio \\

&#x20; --model-dir models/customvoice-0.6b \\

&#x20; --text "Привет, это тест голоса на русском!" \\

&#x20; --speaker "vivian" \\          # или ryan, emma и т.д. (9 встроенных)

&#x20; --language russian \\

&#x20; --output output.wav



\# Voice cloning (Base модель + референс)

./generate\_audio \\

&#x20; --model-dir models/base-1.7b \\

&#x20; --text "Это мой клонированный голос, звучит круто!" \\

&#x20; --ref-audio reference.wav \\   # любой твой аудиофайл 3+ секунды

&#x20; --ref-text "Текст того, что сказано в reference.wav" \\

&#x20; --language russian \\

&#x20; --output cloned.wav



\# Voice design (описываешь голос текстом)

./generate\_audio \\

&#x20; --model-dir models/voicedesign-1.7b \\

&#x20; --text "Доброе утро, сегодня отличный день!" \\

&#x20; --instruct "Энергичный молодой мужской голос с лёгким акцентом, бодрый и дружелюбный" \\

&#x20; --language russian \\

&#x20; --output designed.wav



Vivian	Bright, slightly edgy young female voice.	Chinese

Serena	Warm, gentle young female voice.	Chinese

Uncle\_Fu	Seasoned male voice with a low, mellow timbre.	Chinese

Dylan	Youthful Beijing male voice with a clear, natural timbre.	Chinese (Beijing Dialect)

Eric	Lively Chengdu male voice with a slightly husky brightness.	Chinese (Sichuan Dialect)

Ryan	Dynamic male voice with strong rhythmic drive.	English

Aiden	Sunny American male voice with a clear midrange.	English

Ono\_Anna	Playful Japanese female voice with a light, nimble timbre.	Japanese

Sohee	Warm Korean female voice with rich emotion.	Korean



http://localhost:3001/customvoice?text=%D0%97%D0%B4%D1%80%D0%B0%D0%B2%D1%81%D1%82%D0%B2%D1%83%D0%B9%D1%82%D0%B5%20%D0%BC%D0%BE%D0%B8%20%D0%BC%D0%B0%D0%BB%D0%B5%D0%BD%D1%8C%D0%BA%D0%B8%D0%B5%20%D1%87%D0%B8%D0%BB%D0%B4%D1%80%D1%91%D0%BD%D1%8B%D1%88%D0%B8!%20%D0%9F%D0%B8%D1%81%D1%8C%D0%BA%D0%B0%20%D0%BF%D0%BE%D0%BF%D0%BA%D0%B0%20%D0%BA%D0%B0%D0%BA%D0%B0%D1%88%D0%BA%D0%B0!\&speaker=Ryan\&model=customvoice-1.7b\&language=russian\&instruct=%D0%B2%D0%B4%D1%83%D0%BC%D1%87%D0%B8%D0%B2%D0%BE



server readme

https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/README.md

