// WEB PORT: small persistent thread pool.
//
// The original engine creates new std::threads on every Clear/Differed/RenderObjectsPooled
// call. In the browser every std::thread is a Web Worker, so spawning them per frame is
// far too slow (and can dead-lock the main thread if no pre-created worker is free).
// Instead the workers are created once (InitThreadPool) and reused for every call.
//
// When built without -pthread (single-threaded fallback build) RunParallel simply runs
// the job on the calling thread; the engine's work loops use dynamic scheduling with an
// atomic counter, so one participant still processes all of the work.
#pragma once

#include <algorithm>
#include <functional>
#include <vector>

#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)
#define BG_NO_THREADS 1
#endif

#ifndef BG_NO_THREADS
#include <condition_variable>
#include <mutex>
#include <thread>
#endif

namespace bgpool
{
#ifndef BG_NO_THREADS
	inline std::vector<std::thread> Workers;
	inline std::mutex Mutex;
	inline std::condition_variable WorkReady;
	inline std::condition_variable WorkDone;
	inline const std::function<void(int)>* Job = nullptr;
	inline int Generation = 0;
	inline int Participants = 0;   // threads taking part in the current job (incl. caller)
	inline int Remaining = 0;      // workers that have not finished the current job yet

	inline void WorkerLoop(int index)
	{
		int seen = 0;
		for (;;)
		{
			const std::function<void(int)>* job;
			{
				std::unique_lock<std::mutex> lock(Mutex);
				WorkReady.wait(lock, [&] { return Generation != seen; });
				seen = Generation;
				if (index >= Participants) continue;
				job = Job;
			}

			(*job)(index);

			std::lock_guard<std::mutex> lock(Mutex);
			if (--Remaining == 0) WorkDone.notify_one();
		}
	}
#endif
}

// Creates (count - 1) worker threads; the calling thread is participant 0.
inline void InitThreadPool(int count)
{
#ifndef BG_NO_THREADS
	for (int i = (int)bgpool::Workers.size() + 1; i < count; i++)
	{
		bgpool::Workers.emplace_back(bgpool::WorkerLoop, i);
		bgpool::Workers.back().detach();
	}
#else
	(void)count;
#endif
}

// Total number of threads that can take part in a job (workers + caller).
inline int ThreadPoolSize()
{
#ifndef BG_NO_THREADS
	return (int)bgpool::Workers.size() + 1;
#else
	return 1;
#endif
}

// Runs fn(threadIndex) on up to numThreads threads and waits until all of them return.
inline void RunParallel(int numThreads, const std::function<void(int)>& fn)
{
#ifndef BG_NO_THREADS
	int participants = std::min(numThreads, ThreadPoolSize());
	if (participants <= 1)
	{
		fn(0);
		return;
	}

	{
		std::lock_guard<std::mutex> lock(bgpool::Mutex);
		bgpool::Job = &fn;
		bgpool::Participants = participants;
		bgpool::Remaining = participants - 1;
		bgpool::Generation++;
	}
	bgpool::WorkReady.notify_all();

	fn(0);

	std::unique_lock<std::mutex> lock(bgpool::Mutex);
	bgpool::WorkDone.wait(lock, [] { return bgpool::Remaining == 0; });
#else
	(void)numThreads;
	fn(0);
#endif
}
