// The engine's side of the studio protocol (doc 16 §4): JSON lines on a private copy of stdout, so anything a plugin
// prints (to fd 1) lands in the engine log (fd 2), never in the protocol. A reader thread takes stdin lines and hands
// each command to the message thread (VST3 and every Edit change live there); replies and events are written under
// one lock. End of input (the studio went away) quits the engine.
#pragma once
#include <JuceHeader.h>
#include <atomic>
#include <functional>
#include <mutex>
#include <thread>
#include <unistd.h>

namespace mfx
{
    class Protocol
    {
    public:
        using Handler = std::function<juce::var (const juce::String& cmd, const juce::var& args)>;

        // Must run before JUCE or any plugin prints: fd 1 → the protocol, then fd 1 points at fd 2.
        static int takeStdout()
        {
            const int proto = ::dup (1);
            ::dup2 (2, 1);
            return proto;
        }

        Protocol (int fd, Handler h) : out (fd), handler (std::move (h)) {}
        ~Protocol() { stop(); }

        void start()
        {
            reader = std::thread ([this] { readLoop(); });
            beat = std::thread ([this] { aliveLoop(); });
        }

        void stop()
        {
            running = false;
            if (beat.joinable()) beat.join();
            if (reader.joinable()) reader.detach();   // blocked on stdin; the process is ending
        }

        void event (const juce::String& name, juce::DynamicObject::Ptr fields)
        {
            if (fields == nullptr) fields = new juce::DynamicObject();
            fields->setProperty ("ev", name);
            write (juce::var (fields.get()));
        }

        void log (const juce::String& level, const juce::String& text)
        {
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("level", level);
            o->setProperty ("text", text);
            event ("log", o);
        }

        std::function<void()> onEnd;    // stdin closed

    private:
        int out;
        Handler handler;
        std::mutex writing;
        std::atomic<bool> running { true };
        std::thread reader, beat;
        const juce::uint32 started = juce::Time::getMillisecondCounter();

        void write (const juce::var& v)
        {
            auto line = juce::JSON::toString (v, true) + "\n";
            std::lock_guard<std::mutex> g (writing);
            auto utf8 = line.toRawUTF8();
            auto left = (ssize_t) std::strlen (utf8);
            while (left > 0)
            {
                auto n = ::write (out, utf8, (size_t) left);
                if (n <= 0) return;
                utf8 += n; left -= n;
            }
        }

        void reply (const juce::var& id, bool ok, const juce::var& resultOrError)
        {
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("id", id);
            o->setProperty ("ok", ok);
            o->setProperty (ok ? "result" : "error", resultOrError);
            write (juce::var (o.get()));
        }

        void readLoop()
        {
            std::string line;
            char c;
            while (running && ::read (0, &c, 1) == 1)
            {
                if (c != '\n') { line.push_back (c); continue; }
                auto msg = juce::JSON::parse (juce::String::fromUTF8 (line.data(), (int) line.size()));
                line.clear();
                if (! msg.isObject()) continue;
                auto id = msg["id"];
                auto cmd = msg["cmd"].toString();
                auto args = msg["args"];
                // engine.ping answers here, at once: it must work even when the message thread is busy
                if (cmd == "engine.ping") { reply (id, true, juce::var (new juce::DynamicObject())); continue; }
                juce::MessageManager::callAsync ([this, id, cmd, args]
                {
                    try { reply (id, true, handler (cmd, args)); }
                    catch (const std::exception& e) { reply (id, false, juce::String (e.what())); }
                });
            }
            running = false;
            juce::MessageManager::callAsync ([this] { if (onEnd) onEnd(); });
        }

        void aliveLoop()
        {
            while (running)
            {
                for (int i = 0; i < 10 && running; ++i) std::this_thread::sleep_for (std::chrono::milliseconds (100));
                if (! running) break;
                juce::DynamicObject::Ptr o = new juce::DynamicObject();
                o->setProperty ("uptimeMs", (int) (juce::Time::getMillisecondCounter() - started));
                event ("alive", o);
            }
        }
    };
}
