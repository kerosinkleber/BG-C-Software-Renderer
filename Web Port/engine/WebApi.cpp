// WEB PORT: JavaScript-facing API for the BG raster engine.
//
// The original exports take structs by value (Vector3, Color, Color32) and return a struct
// (Vector4Int). In the WebAssembly C ABI those are passed through hidden pointers, which is
// awkward to call from JS, so this file wraps them with plain float/int parameters. It also
// owns the frame buffers (in Unity they were C# arrays) and converts the finished frame
// into canvas-ready RGBA.
//
// The engine is compiled as part of this translation unit so the wrappers can reach its
// globals (Width, Height, RenderTexture, ...) without changing the engine source.
#include "MainEngine.cpp"

namespace
{
	// The rasterizer can write one pixel past the end of a scanline (its x loop is inclusive
	// and clamps to Width, not Width - 1), so every buffer gets a row of padding.
	std::vector<Color32> FrameColor;
	std::vector<Color32> FrameNormals;
	std::vector<float> FrameDepth;
	std::vector<Color32> FrameOut;      // flipped, opaque RGBA for the canvas
	std::vector<BgTrans> ObjectBuffer;
	std::vector<PointLight> PointLightBuffer;
	Vector4Int LastStats = { 0, 0, 0, 0 };

	inline Vector3 V3(float x, float y, float z) { return { x, y, z }; }
	inline Color Col(float r, float g, float b) { return { r, g, b, 1.0f }; }
	inline Color32 Col32(int r, int g, int b) { return { (uint8_t)r, (uint8_t)g, (uint8_t)b, 255 }; }
}

extern "C"
{
	// Creates the worker threads. count = total render threads (including the calling thread).
	EMSCRIPTEN_KEEPALIVE int bg_init_threads(int count)
	{
		InitThreadPool(count);
		return ThreadPoolSize();
	}

	EMSCRIPTEN_KEEPALIVE int bg_thread_count()
	{
		return ThreadPoolSize();
	}

	// Allocates the frame buffers. Unlike InitializeBuffers this keeps loaded meshes/textures,
	// so it can be called again whenever the canvas resolution changes.
	EMSCRIPTEN_KEEPALIVE void bg_resize(int width, int height)
	{
		size_t padded = (size_t)width * (size_t)(height + 1) + 16;
		FrameColor.assign(padded, Color32{ 0, 0, 0, 0 });
		FrameNormals.assign(padded, Color32{ 0, 0, 0, 0 });
		FrameDepth.assign(padded, 100000000.0f);
		FrameOut.assign((size_t)width * (size_t)height, Color32{ 0, 0, 0, 255 });

		RenderTexture = FrameColor.data();
		ScreenNorms = FrameNormals.data();
		Depth = FrameDepth.data();
		Width = width;
		Height = height;
	}

	// Removes all meshes and textures (see DestroyBuffers in the engine).
	EMSCRIPTEN_KEEPALIVE void bg_reset_scene()
	{
		DestroyBuffers(0);
	}

	EMSCRIPTEN_KEEPALIVE void bg_set_camera(
		float fx, float fy, float fz,
		float px, float py, float pz,
		float ux, float uy, float uz,
		float rx, float ry, float rz,
		float aspectRatio, float tanFovHalf)
	{
		SetCameraSettings(Width, Height, V3(fx, fy, fz), V3(px, py, pz), V3(ux, uy, uz), V3(rx, ry, rz),
			aspectRatio, tanFovHalf);
	}

	// Returns a buffer for `count` point lights (layout: color rgba, position xyz, range).
	// Fill it from JS, then call bg_set_lighting with the same count.
	EMSCRIPTEN_KEEPALIVE PointLight* bg_point_light_buffer(int count)
	{
		PointLightBuffer.resize(count > 0 ? count : 1);
		return PointLightBuffer.data();
	}

	// Colors are 0..1 floats like Unity's Color.
	EMSCRIPTEN_KEEPALIVE void bg_set_lighting(
		float sdx, float sdy, float sdz,
		float sr, float sg, float sb, float sunIntensity,
		float ar, float ag, float ab,
		float gr, float gg, float gb,
		float skr, float skg, float skb,
		float hr, float hg, float hb,
		float fr, float fg, float fb, float fogDistance,
		int pointLightCount)
	{
		if (PointLightBuffer.empty()) PointLightBuffer.resize(1);
		SetLighting(V3(sdx, sdy, sdz), Col(sr, sg, sb), sunIntensity, Col(ar, ag, ab), Col(gr, gg, gb),
			Col(skr, skg, skb), Col(hr, hg, hb), PointLightBuffer.data(), pointLightCount,
			Col(fr, fg, fb), fogDistance);
	}

	// Clears depth/normals and draws the sky gradient. Colors are 0..255.
	EMSCRIPTEN_KEEPALIVE void bg_clear(int threads, int skyR, int skyG, int skyB, int horR, int horG, int horB)
	{
		Clear(threads, Col32(skyR, skyG, skyB), Col32(horR, horG, horB));
	}

	// Returns a buffer for `count` objects (BgTrans: position xyz, scale xyzw, rotation xyzw,
	// meshindex, tint rgba8 = 13 x 4 bytes).
	EMSCRIPTEN_KEEPALIVE BgTrans* bg_object_buffer(int count)
	{
		ObjectBuffer.resize(count > 0 ? count : 1);
		return ObjectBuffer.data();
	}

	// Rasterizes the first `count` objects of the object buffer. Returns drawn pixel count
	// (only counted on the non-SIMD path, as in the original); bg_stats() has all stats.
	EMSCRIPTEN_KEEPALIVE int bg_render(int threads, int count, bool debugTriangles, bool useSimd, bool vertexLight)
	{
		LastStats = RenderObjectsPooled(ObjectBuffer.data(), threads, count, debugTriangles, useSimd, vertexLight);
		return LastStats.x;
	}

	// [pixels, triangles, unused, unused] from the last bg_render call.
	EMSCRIPTEN_KEEPALIVE Vector4Int* bg_stats()
	{
		return &LastStats;
	}

	EMSCRIPTEN_KEEPALIVE void bg_deferred(int threads)
	{
		Differed(threads);
	}

	// Converts the engine's frame (bottom-up rows, alpha = specular/metal data) into a
	// top-down, fully opaque RGBA image and returns a pointer to it (Width * Height * 4 bytes).
	EMSCRIPTEN_KEEPALIVE Color32* bg_present()
	{
		const uint32_t opaque = 0xFF000000u;
		for (int y = 0; y < Height; y++)
		{
			const uint32_t* src = reinterpret_cast<const uint32_t*>(&FrameColor[(size_t)(Height - 1 - y) * Width]);
			uint32_t* dst = reinterpret_cast<uint32_t*>(&FrameOut[(size_t)y * Width]);
			for (int x = 0; x < Width; x++)
			{
				dst[x] = src[x] | opaque;
			}
		}
		return FrameOut.data();
	}

	EMSCRIPTEN_KEEPALIVE int bg_width() { return Width; }
	EMSCRIPTEN_KEEPALIVE int bg_height() { return Height; }
}
