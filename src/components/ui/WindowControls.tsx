"use client";

import { useState } from "react";
import { Window } from "@tauri-apps/api/window";
import { X, Minus, Square } from "lucide-react";

type OsType = "mac" | "windows" | "linux" | "unknown";

function detectOS(): OsType {
    if (typeof window === "undefined") return "unknown";
    const platform = navigator.userAgent.toLowerCase();
    if (platform.includes("mac")) return "mac";
    if (platform.includes("win")) return "windows";
    if (platform.includes("linux")) return "linux";
    return "unknown";
}

function getTauriWindow(): Window | null {
    try {
        return Window.getCurrent();
    } catch {
        return null;
    }
}

interface WindowControlsProps {
    placement?: "left" | "right";
}

export default function WindowControls({ placement = "right" }: WindowControlsProps) {
    const [osType] = useState<OsType>(detectOS);
    const [appWindow] = useState(() => getTauriWindow());

    if (osType === "unknown" || !appWindow) return null;

    // Filter controls strictly by placement
    if (osType === "mac" && placement !== "left") return null;
    if (osType !== "mac" && placement !== "right") return null;

    const handleMinimize = async () => {
        try {
            await appWindow.minimize();
        } catch (error) {
            console.error("Failed to minimize window:", error);
        }
    };

    const handleMaximize = async () => {
        try {
            await appWindow.toggleMaximize();
        } catch (error) {
            console.error("Failed to toggle maximize window:", error);
        }
    };

    const handleClose = async () => {
        try {
            await appWindow.close();
        } catch (error) {
            console.error("Failed to close window:", error);
        }
    };

    if (osType === "mac") {
        // Mac-style traffic lights
        return (
            <div className="flex items-center gap-2 px-4 py-3 group">
                <button
                    onClick={handleClose}
                    className="flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f56] hover:bg-[#ff5f56]/90 active:bg-[#ff5f56]/80"
                    title="Close"
                />
                <button
                    onClick={handleMinimize}
                    className="flex h-3 w-3 items-center justify-center rounded-full bg-[#ffbd2e] hover:bg-[#ffbd2e]/90 active:bg-[#ffbd2e]/80"
                    title="Minimize"
                />
                <button
                    onClick={handleMaximize}
                    className="flex h-3 w-3 items-center justify-center rounded-full bg-[#27c93f] hover:bg-[#27c93f]/90 active:bg-[#27c93f]/80"
                    title="Zoom"
                />
            </div>
        );
    }

    // Windows/Linux classic icons
    return (
        <div className="flex items-center">
            <button
                onClick={handleMinimize}
                className="flex h-[32px] w-[46px] items-center justify-center text-text-muted transition-colors hover:bg-overlay-10 hover:text-text"
                title="Minimize"
            >
                <Minus className="h-4 w-4" />
            </button>
            <button
                onClick={handleMaximize}
                className="flex h-[32px] w-[46px] items-center justify-center text-text-muted transition-colors hover:bg-overlay-10 hover:text-text"
                title="Maximize"
            >
                <Square className="h-3.5 w-3.5" />
            </button>
            <button
                onClick={handleClose}
                className="flex h-[32px] w-[46px] items-center justify-center text-text-muted transition-colors hover:bg-error/80 hover:text-text"
                title="Close"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
