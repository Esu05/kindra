import { RateLimiterPrisma } from "rate-limiter-flexible";
import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";

const FREE_POINTS = 5;
const PRO_POINTS = 75;
const DURATION = 30 * 24 * 60 * 60; // 30 days
const GENERATION_COST = 1;

export async function getUsageTracker() {
    const { has } = await auth();
    const hasProAccess = has({ plan: "pro" });

    const usageTracker = new RateLimiterPrisma({
        storeClient: prisma,
        tableName: "Usage",
        points: hasProAccess ? PRO_POINTS : FREE_POINTS,
        duration: DURATION,
    });

    return usageTracker;
}

export async function consumeCredits() {
    const { userId } = await auth();

    if (!userId) {
        throw new Error("User not authenticated");
    }

    const usageTracker = await getUsageTracker();
    const result = await usageTracker.consume(userId, GENERATION_COST);

    return result;
}

export async function refundCredit(userIdParam?: string) {
    const { userId: authUserId } = await auth();
    const userId = userIdParam || authUserId;

    if (!userId) {
        throw new Error("User not authenticated");
    }

    try {
        const usageTracker = await getUsageTracker();
        // Reward back the consumed point (refund)
        await usageTracker.reward(userId, GENERATION_COST);
        console.log(`Refunded ${GENERATION_COST} credit to user ${userId}`);
    } catch (error) {
        console.error("Error refunding credit:", error);
        throw error;
    }
}

export async function getUsageStatus() {
    const { userId, has } = await auth();

    if (!userId) {
        throw new Error("User not authenticated");
    }

    const hasProAccess = has({ plan: "pro" });
    const maxPoints = hasProAccess ? PRO_POINTS : FREE_POINTS;

    const usageTracker = await getUsageTracker();

    try {
        const result = await usageTracker.get(userId);

        if (!result) {
            // User hasn't used any credits yet
            return {
                remainingPoints: maxPoints,
                msBeforeNext: 0,
                consumedPoints: 0,
                isFirstInDuration: true,
            };
        }

        return {
            remainingPoints: result.remainingPoints,
            msBeforeNext: result.msBeforeNext,
            consumedPoints: result.consumedPoints,
            isFirstInDuration: result.isFirstInDuration,
        };
    } catch (error) {
        // If user record doesn't exist yet, return full points
        return {
            remainingPoints: maxPoints,
            msBeforeNext: 0,
            consumedPoints: 0,
            isFirstInDuration: true,
        };
    }
}